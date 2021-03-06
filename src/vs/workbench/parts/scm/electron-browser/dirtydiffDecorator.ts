/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import nls = require('vs/nls');

import 'vs/css!./media/dirtydiffDecorator';
import { ThrottledDelayer, always } from 'vs/base/common/async';
import { IDisposable, dispose, toDisposable, empty as EmptyDisposable, combinedDisposable } from 'vs/base/common/lifecycle';
import { TPromise } from 'vs/base/common/winjs.base';
import Event, { Emitter, anyEvent as anyEvent, filterEvent, once } from 'vs/base/common/event';
import * as ext from 'vs/workbench/common/contributions';
import { CodeEditor } from 'vs/editor/browser/codeEditor';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IMessageService, Severity } from 'vs/platform/message/common/message';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { ITextModelService } from 'vs/editor/common/services/resolverService';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IModelService } from 'vs/editor/common/services/modelService';
import { IEditorWorkerService } from 'vs/editor/common/services/editorWorkerService';
import URI from 'vs/base/common/uri';
import { IEditorGroupService } from 'vs/workbench/services/group/common/groupService';
import { ISCMService, ISCMRepository } from 'vs/workbench/services/scm/common/scm';
import { ModelDecorationOptions } from 'vs/editor/common/model/textModelWithDecorations';
import { registerThemingParticipant, ITheme, ICssStyleCollector, themeColorFromId, IThemeService } from 'vs/platform/theme/common/themeService';
import { registerColor } from 'vs/platform/theme/common/colorRegistry';
import { localize } from 'vs/nls';
import { Color, RGBA } from 'vs/base/common/color';
import { ICodeEditor, IEditorMouseEvent, MouseTargetType } from 'vs/editor/browser/editorBrowser';
import { editorContribution } from 'vs/editor/browser/editorBrowserExtensions';
import { editorAction, ServicesAccessor, EditorAction, CommonEditorRegistry } from 'vs/editor/common/editorCommonExtensions';
import { PeekViewWidget, getOuterEditor } from 'vs/editor/contrib/referenceSearch/browser/peekViewWidget';
import { IContextKeyService, IContextKey, ContextKeyExpr, RawContextKey } from 'vs/platform/contextkey/common/contextkey';
import { EditorContextKeys } from 'vs/editor/common/editorContextKeys';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { Position } from 'vs/editor/common/core/position';
import { rot } from 'vs/base/common/numbers';
import { KeybindingsRegistry } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { peekViewBorder, peekViewTitleBackground, peekViewTitleForeground, peekViewTitleInfoForeground } from 'vs/editor/contrib/referenceSearch/browser/referencesWidget';
import { EmbeddedDiffEditorWidget } from 'vs/editor/browser/widget/embeddedCodeEditorWidget';
import { IDiffEditorOptions } from 'vs/editor/common/config/editorOptions';
import { Action, IAction, ActionRunner } from 'vs/base/common/actions';
import { IActionBarOptions, ActionsOrientation, IActionItem } from 'vs/base/browser/ui/actionbar/actionbar';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { basename } from 'vs/base/common/paths';
import { MenuId, IMenuService, IMenu, MenuItemAction } from 'vs/platform/actions/common/actions';
import { fillInActions, MenuItemActionItem } from 'vs/platform/actions/browser/menuItemActionItem';
import { IChange, ICommonCodeEditor, IEditorModel, ScrollType, IEditorContribution, OverviewRulerLane, IModel } from 'vs/editor/common/editorCommon';
import { sortedDiff, Splice, firstIndex } from 'vs/base/common/arrays';
import { IMarginData } from 'vs/editor/browser/controller/mouseTarget';
import { ICodeEditorService } from 'vs/editor/common/services/codeEditorService';

// TODO@Joao
// Need to subclass MenuItemActionItem in order to respect
// the action context coming from any action bar, without breaking
// existing users
class DiffMenuItemActionItem extends MenuItemActionItem {

	onClick(event: MouseEvent): void {
		event.preventDefault();
		event.stopPropagation();

		this.actionRunner.run(this._commandAction, this._context)
			.done(undefined, err => this._messageService.show(Severity.Error, err));
	}
}

class DiffActionRunner extends ActionRunner {

	runAction(action: IAction, context: any): TPromise<any> {
		if (action instanceof MenuItemAction) {
			return action.run(...context);
		}

		return super.runAction(action, context);
	}
}

export interface IModelRegistry {
	getModel(editorModel: IEditorModel): DirtyDiffModel;
}

export const isDirtyDiffVisible = new RawContextKey<boolean>('dirtyDiffVisible', false);

function getChangeHeight(change: IChange): number {
	const modified = change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1;
	const original = change.originalEndLineNumber - change.originalStartLineNumber + 1;

	if (change.originalEndLineNumber === 0) {
		return modified;
	} else if (change.modifiedEndLineNumber === 0) {
		return original;
	} else {
		return modified + original;
	}
}

function getModifiedEndLineNumber(change: IChange): number {
	if (change.modifiedEndLineNumber === 0) {
		return change.modifiedStartLineNumber === 0 ? 1 : change.modifiedStartLineNumber;
	} else {
		return change.modifiedEndLineNumber;
	}
}

function lineIntersectsChange(lineNumber: number, change: IChange): boolean {
	// deletion at the beginning of the file
	if (lineNumber === 1 && change.modifiedStartLineNumber === 0 && change.modifiedEndLineNumber === 0) {
		return true;
	}

	return lineNumber >= change.modifiedStartLineNumber && lineNumber <= (change.modifiedEndLineNumber || change.modifiedStartLineNumber);
}

class UIEditorAction extends Action {

	private editor: ICommonCodeEditor;
	private action: EditorAction;
	private instantiationService: IInstantiationService;

	constructor(
		editor: ICommonCodeEditor,
		action: EditorAction,
		cssClass: string,
		@IKeybindingService keybindingService: IKeybindingService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		const keybinding = keybindingService.lookupKeybinding(action.id);
		const label = action.label + (keybinding ? ` (${keybinding.getLabel()})` : '');

		super(action.id, label, cssClass);

		this.instantiationService = instantiationService;
		this.action = action;
		this.editor = editor;
	}

	run(): TPromise<any> {
		return TPromise.wrap(this.instantiationService.invokeFunction(accessor => this.action.run(accessor, this.editor, null)));
	}
}

enum ChangeType {
	Modify,
	Add,
	Delete
}

function getChangeType(change: IChange): ChangeType {
	if (change.originalEndLineNumber === 0) {
		return ChangeType.Add;
	} else if (change.modifiedEndLineNumber === 0) {
		return ChangeType.Delete;
	} else {
		return ChangeType.Modify;
	}
}

function getChangeTypeColor(theme: ITheme, changeType: ChangeType): Color {
	switch (changeType) {
		case ChangeType.Modify: return theme.getColor(editorGutterModifiedBackground);
		case ChangeType.Add: return theme.getColor(editorGutterAddedBackground);
		case ChangeType.Delete: return theme.getColor(editorGutterDeletedBackground);
	}
}

function getOuterEditorFromDiffEditor(accessor: ServicesAccessor): ICommonCodeEditor {
	const diffEditors = accessor.get(ICodeEditorService).listDiffEditors();

	for (const diffEditor of diffEditors) {
		if (diffEditor.isFocused() && diffEditor instanceof EmbeddedDiffEditorWidget) {
			return diffEditor.getParentEditor();
		}
	}

	return getOuterEditor(accessor);
}

class DirtyDiffWidget extends PeekViewWidget {

	private diffEditor: EmbeddedDiffEditorWidget;
	private title: string;
	private menu: IMenu;
	private index: number;
	private change: IChange;
	private height: number | undefined = undefined;
	private contextKeyService: IContextKeyService;

	constructor(
		editor: ICodeEditor,
		private model: DirtyDiffModel,
		@IThemeService private themeService: IThemeService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IMenuService private menuService: IMenuService,
		@IKeybindingService private keybindingService: IKeybindingService,
		@IMessageService private messageService: IMessageService,
		@IContextKeyService contextKeyService: IContextKeyService
	) {
		super(editor, { isResizeable: true, frameWidth: 1 });

		themeService.onThemeChange(this._applyTheme, this, this._disposables);
		this._applyTheme(themeService.getTheme());

		this.contextKeyService = contextKeyService.createScoped();
		this.contextKeyService.createKey('originalResourceScheme', this.model.original.uri.scheme);
		this.menu = menuService.createMenu(MenuId.SCMChangeContext, this.contextKeyService);

		this.create();
		this.title = basename(editor.getModel().uri.fsPath);
		this.setTitle(this.title);

		model.onDidChange(this.renderTitle, this, this._disposables);
	}

	showChange(index: number): void {
		const change = this.model.changes[index];
		this.index = index;
		this.change = change;

		const originalModel = this.model.original;

		if (!originalModel) {
			return;
		}

		const onFirstDiffUpdate = once(this.diffEditor.onDidUpdateDiff);

		// TODO@joao TODO@alex need this setTimeout probably because the
		// non-side-by-side diff still hasn't created the view zones
		onFirstDiffUpdate(() => setTimeout(() => this.revealChange(change), 0));

		this.diffEditor.setModel(this.model);

		const position = new Position(getModifiedEndLineNumber(change), 1);

		const lineHeight = this.editor.getConfiguration().lineHeight;
		const editorHeight = this.editor.getLayoutInfo().height;
		const editorHeightInLines = Math.floor(editorHeight / lineHeight);
		const height = Math.min(getChangeHeight(change) + /* padding */ 8, Math.floor(editorHeightInLines / 3));

		this.renderTitle();

		const changeType = getChangeType(change);
		const changeTypeColor = getChangeTypeColor(this.themeService.getTheme(), changeType);
		this.style({ frameColor: changeTypeColor });

		this._actionbarWidget.context = [this.model.modified.uri, this.model.changes, index];
		this.show(position, height);
		this.editor.focus();
	}

	private renderTitle(): void {
		const detail = this.model.changes.length > 1
			? localize('changes', "{0} of {1} changes", this.index + 1, this.model.changes.length)
			: localize('change', "{0} of {1} change", this.index + 1, this.model.changes.length);

		this.setTitle(this.title, detail);
	}

	protected _fillHead(container: HTMLElement): void {
		super._fillHead(container);

		const previous = this.instantiationService.createInstance(UIEditorAction, this.editor, new ShowPreviousChangeAction(), 'show-previous-change octicon octicon-chevron-up');
		const next = this.instantiationService.createInstance(UIEditorAction, this.editor, new ShowNextChangeAction(), 'show-next-change octicon octicon-chevron-down');

		this._disposables.push(previous);
		this._disposables.push(next);
		this._actionbarWidget.push([previous, next], { label: false, icon: true });

		const actions: IAction[] = [];
		fillInActions(this.menu, { shouldForwardArgs: true }, actions);
		this._actionbarWidget.push(actions, { label: false, icon: true });
	}

	protected _getActionBarOptions(): IActionBarOptions {
		return {
			actionRunner: new DiffActionRunner(),
			actionItemProvider: action => this.getActionItem(action),
			orientation: ActionsOrientation.HORIZONTAL_REVERSE
		};
	}

	getActionItem(action: IAction): IActionItem {
		if (!(action instanceof MenuItemAction)) {
			return undefined;
		}

		return new DiffMenuItemActionItem(action, this.keybindingService, this.messageService);
	}

	protected _fillBody(container: HTMLElement): void {
		const options: IDiffEditorOptions = {
			scrollBeyondLastLine: true,
			scrollbar: {
				verticalScrollbarSize: 14,
				horizontal: 'auto',
				useShadows: true,
				verticalHasArrows: false,
				horizontalHasArrows: false
			},
			overviewRulerLanes: 2,
			fixedOverflowWidgets: true,
			minimap: { enabled: false },
			renderSideBySide: false,
			readOnly: true
		};

		this.diffEditor = this.instantiationService.createInstance(EmbeddedDiffEditorWidget, container, options, this.editor);
	}

	_onWidth(width: number): void {
		if (typeof this.height === 'undefined') {
			return;
		}

		this.diffEditor.layout({ height: this.height, width });
	}

	protected _doLayoutBody(height: number, width: number): void {
		super._doLayoutBody(height, width);
		this.diffEditor.layout({ height, width });

		if (typeof this.height === 'undefined') {
			this.revealChange(this.change);
		}

		this.height = height;
	}

	private revealChange(change: IChange): void {
		let start: number, end: number;

		if (change.modifiedEndLineNumber === 0) { // deletion
			start = change.modifiedStartLineNumber;
			end = change.modifiedStartLineNumber + 1;
		} else if (change.originalEndLineNumber > 0) { // modification
			start = change.modifiedStartLineNumber - 1;
			end = change.modifiedEndLineNumber + 1;
		} else { // insertion
			start = change.modifiedStartLineNumber;
			end = change.modifiedEndLineNumber;
		}

		this.diffEditor.revealLinesInCenter(start, end, ScrollType.Immediate);
	}

	private _applyTheme(theme: ITheme) {
		let borderColor = theme.getColor(peekViewBorder) || Color.transparent;
		this.style({
			arrowColor: borderColor,
			frameColor: borderColor,
			headerBackgroundColor: theme.getColor(peekViewTitleBackground) || Color.transparent,
			primaryHeadingColor: theme.getColor(peekViewTitleForeground),
			secondaryHeadingColor: theme.getColor(peekViewTitleInfoForeground)
		});
	}

	protected revealLine(lineNumber: number) {
		this.editor.revealLineInCenterIfOutsideViewport(lineNumber, ScrollType.Smooth);
	}
}

@editorAction
export class ShowPreviousChangeAction extends EditorAction {

	constructor() {
		super({
			id: 'editor.action.dirtydiff.previous',
			label: nls.localize('show previous change', "Show Previous Change"),
			alias: 'Show Previous Change',
			precondition: null,
			kbOpts: { kbExpr: EditorContextKeys.textFocus, primary: KeyMod.Shift | KeyMod.Alt | KeyCode.F3 }
		});
	}

	run(accessor: ServicesAccessor, editor: ICommonCodeEditor): void {
		const outerEditor = getOuterEditorFromDiffEditor(accessor);

		if (!outerEditor) {
			return;
		}

		const controller = DirtyDiffController.get(outerEditor);

		if (!controller) {
			return;
		}

		if (!controller.canNavigate()) {
			return;
		}

		controller.previous();
	}
}

@editorAction
export class ShowNextChangeAction extends EditorAction {

	constructor() {
		super({
			id: 'editor.action.dirtydiff.next',
			label: nls.localize('show next change', "Show Next Change"),
			alias: 'Show Next Change',
			precondition: null,
			kbOpts: { kbExpr: EditorContextKeys.textFocus, primary: KeyMod.Alt | KeyCode.F3 }
		});
	}

	run(accessor: ServicesAccessor, editor: ICommonCodeEditor): void {
		const outerEditor = getOuterEditorFromDiffEditor(accessor);

		if (!outerEditor) {
			return;
		}

		const controller = DirtyDiffController.get(outerEditor);

		if (!controller) {
			return;
		}

		if (!controller.canNavigate()) {
			return;
		}

		controller.next();
	}
}

KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: 'closeDirtyDiff',
	weight: CommonEditorRegistry.commandWeight(50),
	primary: KeyCode.Escape,
	secondary: [KeyMod.Shift | KeyCode.Escape],
	when: ContextKeyExpr.and(isDirtyDiffVisible),
	handler: (accessor: ServicesAccessor) => {
		const outerEditor = getOuterEditorFromDiffEditor(accessor);

		if (!outerEditor) {
			return;
		}

		const controller = DirtyDiffController.get(outerEditor);

		if (!controller) {
			return;
		}

		controller.close();
	}
});

@editorContribution
export class DirtyDiffController implements IEditorContribution {

	private static ID = 'editor.contrib.dirtydiff';

	static get(editor: ICommonCodeEditor): DirtyDiffController {
		return editor.getContribution<DirtyDiffController>(DirtyDiffController.ID);
	}

	modelRegistry: IModelRegistry | null = null;

	private model: DirtyDiffModel | null = null;
	private widget: DirtyDiffWidget | null = null;
	private currentLineNumber: number = -1;
	private currentIndex: number = -1;
	private readonly isDirtyDiffVisible: IContextKey<boolean>;
	private session: IDisposable = EmptyDisposable;
	private mouseDownInfo: { lineNumber: number } | null = null;
	private enabled = false;
	private disposables: IDisposable[] = [];

	constructor(
		private editor: ICodeEditor,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IThemeService private themeService: IThemeService,
		@IInstantiationService private instantiationService: IInstantiationService
	) {
		this.enabled = !contextKeyService.getContextKeyValue('isInDiffEditor');

		if (this.enabled) {
			this.isDirtyDiffVisible = isDirtyDiffVisible.bindTo(contextKeyService);
			this.disposables.push(editor.onMouseDown(e => this.onEditorMouseDown(e)));
			this.disposables.push(editor.onMouseUp(e => this.onEditorMouseUp(e)));
			this.disposables.push(editor.onDidChangeModel(() => this.close()));
		}
	}

	getId(): string {
		return DirtyDiffController.ID;
	}

	canNavigate(): boolean {
		return this.currentIndex === -1 || this.model.changes.length > 1;
	}

	next(lineNumber?: number): void {
		if (!this.assertWidget()) {
			return;
		}

		if (typeof lineNumber === 'number' || this.currentIndex === -1) {
			this.currentIndex = this.findNextClosestChange(typeof lineNumber === 'number' ? lineNumber : this.editor.getPosition().lineNumber);
		} else {
			this.currentIndex = rot(this.currentIndex + 1, this.model.changes.length);
		}

		const change = this.model.changes[this.currentIndex];
		this.currentLineNumber = change.modifiedStartLineNumber;

		this.widget.showChange(this.currentIndex);
	}

	previous(lineNumber?: number): void {
		if (!this.assertWidget()) {
			return;
		}

		if (typeof lineNumber === 'number' || this.currentIndex === -1) {
			this.currentIndex = this.findPreviousClosestChange(typeof lineNumber === 'number' ? lineNumber : this.editor.getPosition().lineNumber);
		} else {
			this.currentIndex = rot(this.currentIndex - 1, this.model.changes.length);
		}

		const change = this.model.changes[this.currentIndex];
		this.currentLineNumber = change.modifiedStartLineNumber;

		this.widget.showChange(this.currentIndex);
	}

	close(): void {
		this.session.dispose();
		this.session = EmptyDisposable;
	}

	private assertWidget(): boolean {
		if (!this.enabled) {
			return false;
		}

		if (this.widget) {
			if (this.model.changes.length === 0) {
				this.close();
				return false;
			}

			return true;
		}

		if (!this.modelRegistry) {
			return false;
		}

		const editorModel = this.editor.getModel();

		if (!editorModel) {
			return false;
		}

		const model = this.modelRegistry.getModel(editorModel);

		if (!model) {
			return false;
		}

		if (model.changes.length === 0) {
			return false;
		}

		this.currentIndex = -1;
		this.model = model;
		this.widget = this.instantiationService.createInstance(DirtyDiffWidget, this.editor, model);
		this.isDirtyDiffVisible.set(true);

		const disposables: IDisposable[] = [];
		once(this.widget.onDidClose)(this.close, this, disposables);
		model.onDidChange(this.onDidModelChange, this, disposables);

		disposables.push(
			this.widget,
			toDisposable(() => {
				this.model = null;
				this.widget = null;
				this.currentIndex = -1;
				this.isDirtyDiffVisible.set(false);
				this.editor.focus();
			})
		);

		this.session = combinedDisposable(disposables);
		return true;
	}

	private onDidModelChange(splices: Splice<IChange>[]): void {
		for (const splice of splices) {
			if (splice.start <= this.currentIndex) {
				if (this.currentIndex < splice.start + splice.deleteCount) {
					this.currentIndex = -1;
					this.next();
				} else {
					this.currentIndex = rot(this.currentIndex + splice.inserted.length - splice.deleteCount - 1, this.model.changes.length);
					this.next();
				}
			}
		}
	}

	private onEditorMouseDown(e: IEditorMouseEvent): void {
		this.mouseDownInfo = null;

		const range = e.target.range;

		if (!range) {
			return;
		}

		if (!e.event.leftButton) {
			return;
		}

		if (e.target.type !== MouseTargetType.GUTTER_LINE_DECORATIONS) {
			return;
		}

		const data = e.target.detail as IMarginData;
		const gutterOffsetX = data.offsetX - data.glyphMarginWidth - data.lineNumbersWidth;

		// TODO@joao TODO@alex TODO@martin this is such that we don't collide with folding
		if (gutterOffsetX > 10) {
			return;
		}

		this.mouseDownInfo = { lineNumber: range.startLineNumber };
	}

	private onEditorMouseUp(e: IEditorMouseEvent): void {
		if (!this.mouseDownInfo) {
			return;
		}

		const { lineNumber } = this.mouseDownInfo;
		this.mouseDownInfo = null;

		const range = e.target.range;

		if (!range || range.startLineNumber !== lineNumber) {
			return;
		}

		if (e.target.type !== MouseTargetType.GUTTER_LINE_DECORATIONS) {
			return;
		}

		if (!this.modelRegistry) {
			return;
		}

		const editorModel = this.editor.getModel();

		if (!editorModel) {
			return;
		}

		const model = this.modelRegistry.getModel(editorModel);

		if (!model) {
			return;
		}

		const index = firstIndex(model.changes, change => lineIntersectsChange(lineNumber, change));

		if (index < 0) {
			return;
		}

		if (index === this.currentIndex) {
			this.close();
		} else {
			this.next(lineNumber);
		}
	}

	private findNextClosestChange(lineNumber: number): number {
		for (let i = 0; i < this.model.changes.length; i++) {
			const change = this.model.changes[i];

			if (lineIntersectsChange(lineNumber, change)) {
				return i;
			}
		}

		return 0;
	}

	private findPreviousClosestChange(lineNumber: number): number {
		for (let i = this.model.changes.length - 1; i >= 0; i--) {
			const change = this.model.changes[i];

			if (change.modifiedStartLineNumber <= lineNumber) {
				return i;
			}
		}

		return 0;
	}

	dispose(): void {
		return;
	}
}

export const editorGutterModifiedBackground = registerColor('editorGutter.modifiedBackground', {
	dark: new Color(new RGBA(12, 125, 157)),
	light: new Color(new RGBA(102, 175, 224)),
	hc: new Color(new RGBA(0, 73, 122))
}, localize('editorGutterModifiedBackground', "Editor gutter background color for lines that are modified."));

export const editorGutterAddedBackground = registerColor('editorGutter.addedBackground', {
	dark: new Color(new RGBA(88, 124, 12)),
	light: new Color(new RGBA(129, 184, 139)),
	hc: new Color(new RGBA(27, 82, 37))
}, localize('editorGutterAddedBackground', "Editor gutter background color for lines that are added."));

export const editorGutterDeletedBackground = registerColor('editorGutter.deletedBackground', {
	dark: new Color(new RGBA(148, 21, 27)),
	light: new Color(new RGBA(202, 75, 81)),
	hc: new Color(new RGBA(141, 14, 20))
}, localize('editorGutterDeletedBackground', "Editor gutter background color for lines that are deleted."));

const overviewRulerDefault = new Color(new RGBA(0, 122, 204, 0.6));
export const overviewRulerModifiedForeground = registerColor('editorOverviewRuler.modifiedForeground', { dark: overviewRulerDefault, light: overviewRulerDefault, hc: overviewRulerDefault }, nls.localize('overviewRulerModifiedForeground', 'Overview ruler marker color for modified content.'));
export const overviewRulerAddedForeground = registerColor('editorOverviewRuler.addedForeground', { dark: overviewRulerDefault, light: overviewRulerDefault, hc: overviewRulerDefault }, nls.localize('overviewRulerAddedForeground', 'Overview ruler marker color for added content.'));
export const overviewRulerDeletedForeground = registerColor('editorOverviewRuler.deletedForeground', { dark: overviewRulerDefault, light: overviewRulerDefault, hc: overviewRulerDefault }, nls.localize('overviewRulerDeletedForeground', 'Overview ruler marker color for deleted content.'));

class DirtyDiffDecorator {

	static MODIFIED_DECORATION_OPTIONS = ModelDecorationOptions.register({
		linesDecorationsClassName: 'dirty-diff-glyph dirty-diff-modified',
		isWholeLine: true,
		overviewRuler: {
			color: themeColorFromId(overviewRulerModifiedForeground),
			darkColor: themeColorFromId(overviewRulerModifiedForeground),
			position: OverviewRulerLane.Left
		}
	});

	static ADDED_DECORATION_OPTIONS = ModelDecorationOptions.register({
		linesDecorationsClassName: 'dirty-diff-glyph dirty-diff-added',
		isWholeLine: true,
		overviewRuler: {
			color: themeColorFromId(overviewRulerAddedForeground),
			darkColor: themeColorFromId(overviewRulerAddedForeground),
			position: OverviewRulerLane.Left
		}
	});

	static DELETED_DECORATION_OPTIONS = ModelDecorationOptions.register({
		linesDecorationsClassName: 'dirty-diff-glyph dirty-diff-deleted',
		isWholeLine: true,
		overviewRuler: {
			color: themeColorFromId(overviewRulerDeletedForeground),
			darkColor: themeColorFromId(overviewRulerDeletedForeground),
			position: OverviewRulerLane.Left
		}
	});

	private decorations: string[] = [];
	private disposables: IDisposable[] = [];

	constructor(
		private editorModel: IModel,
		private model: DirtyDiffModel
	) {
		model.onDidChange(this.onDidChange, this, this.disposables);
	}

	private onDidChange(): void {
		const decorations = this.model.changes.map((change) => {
			const changeType = getChangeType(change);
			const startLineNumber = change.modifiedStartLineNumber;
			const endLineNumber = change.modifiedEndLineNumber || startLineNumber;

			switch (changeType) {
				case ChangeType.Add:
					return {
						range: {
							startLineNumber: startLineNumber, startColumn: 1,
							endLineNumber: endLineNumber, endColumn: 1
						},
						options: DirtyDiffDecorator.ADDED_DECORATION_OPTIONS
					};
				case ChangeType.Delete:
					return {
						range: {
							startLineNumber: startLineNumber, startColumn: 1,
							endLineNumber: startLineNumber, endColumn: 1
						},
						options: DirtyDiffDecorator.DELETED_DECORATION_OPTIONS
					};
				case ChangeType.Modify:
					return {
						range: {
							startLineNumber: startLineNumber, startColumn: 1,
							endLineNumber: endLineNumber, endColumn: 1
						},
						options: DirtyDiffDecorator.MODIFIED_DECORATION_OPTIONS
					};
			}
		});

		this.decorations = this.editorModel.deltaDecorations(this.decorations, decorations);
	}

	dispose(): void {
		this.disposables = dispose(this.disposables);

		if (this.editorModel && !this.editorModel.isDisposed()) {
			this.editorModel.deltaDecorations(this.decorations, []);
		}

		this.editorModel = null;
		this.decorations = [];
	}
}

function compareChanges(a: IChange, b: IChange): number {
	let result = a.modifiedStartLineNumber - b.modifiedStartLineNumber;

	if (result !== 0) {
		return result;
	}

	result = a.modifiedEndLineNumber - b.modifiedEndLineNumber;

	if (result !== 0) {
		return result;
	}

	result = a.originalStartLineNumber - b.originalStartLineNumber;

	if (result !== 0) {
		return result;
	}

	return a.originalEndLineNumber - b.originalEndLineNumber;
}

export class DirtyDiffModel {

	private _originalModel: IModel;
	get original(): IModel { return this._originalModel; }
	get modified(): IModel { return this._editorModel; }

	private diffDelayer: ThrottledDelayer<IChange[]>;
	private _originalURIPromise: TPromise<URI>;
	private repositoryDisposables = new Set<IDisposable[]>();
	private disposables: IDisposable[] = [];

	private _onDidChange = new Emitter<Splice<IChange>[]>();
	readonly onDidChange: Event<Splice<IChange>[]> = this._onDidChange.event;

	private _changes: IChange[] = [];
	get changes(): IChange[] {
		return this._changes;
	}

	constructor(
		private _editorModel: IModel,
		@ISCMService private scmService: ISCMService,
		@IModelService private modelService: IModelService,
		@IEditorWorkerService private editorWorkerService: IEditorWorkerService,
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@ITextModelService private textModelResolverService: ITextModelService
	) {
		this.diffDelayer = new ThrottledDelayer<IChange[]>(200);

		this.disposables.push(_editorModel.onDidChangeContent(() => this.triggerDiff()));
		scmService.onDidAddRepository(this.onDidAddRepository, this, this.disposables);
		scmService.repositories.forEach(r => this.onDidAddRepository(r));

		this.triggerDiff();
	}

	private onDidAddRepository(repository: ISCMRepository): void {
		const disposables: IDisposable[] = [];

		this.repositoryDisposables.add(disposables);
		disposables.push(toDisposable(() => this.repositoryDisposables.delete(disposables)));

		const onDidChange = anyEvent(repository.provider.onDidChange, repository.provider.onDidChangeResources);
		onDidChange(this.triggerDiff, this, disposables);

		const onDidRemoveThis = filterEvent(this.scmService.onDidRemoveRepository, r => r === repository);
		onDidRemoveThis(() => dispose(disposables));

		this.triggerDiff();
	}

	private triggerDiff(): TPromise<any> {
		if (!this.diffDelayer) {
			return TPromise.as(null);
		}

		return this.diffDelayer
			.trigger(() => this.diff())
			.then((changes: IChange[]) => {
				if (!this._editorModel || this._editorModel.isDisposed() || !this._originalModel || this._originalModel.isDisposed()) {
					return undefined; // disposed
				}

				if (this._originalModel.getValueLength() === 0) {
					changes = [];
				}

				const diff = sortedDiff(this._changes, changes, compareChanges);
				this._changes = changes;

				if (diff.length > 0) {
					this._onDidChange.fire(diff);
				}
			});
	}

	private diff(): TPromise<IChange[]> {
		return this.getOriginalURIPromise().then(originalURI => {
			if (!this._editorModel || this._editorModel.isDisposed() || !originalURI) {
				return TPromise.as([]); // disposed
			}

			if (!this.editorWorkerService.canComputeDirtyDiff(originalURI, this._editorModel.uri)) {
				return TPromise.as([]); // Files too large
			}

			return this.editorWorkerService.computeDirtyDiff(originalURI, this._editorModel.uri, true);
		});
	}

	private getOriginalURIPromise(): TPromise<URI> {
		if (this._originalURIPromise) {
			return this._originalURIPromise;
		}

		this._originalURIPromise = this.getOriginalResource()
			.then(originalUri => {
				if (!originalUri) {
					this._originalModel = null;
					return null;
				}

				return this.textModelResolverService.createModelReference(originalUri)
					.then(ref => {
						this._originalModel = ref.object.textEditorModel;

						this.disposables.push(ref);
						this.disposables.push(ref.object.textEditorModel.onDidChangeContent(() => this.triggerDiff()));

						return originalUri;
					});
			});

		return always(this._originalURIPromise, () => {
			this._originalURIPromise = null;
		});
	}

	private async getOriginalResource(): TPromise<URI> {
		if (!this._editorModel) {
			return null;
		}

		for (const repository of this.scmService.repositories) {
			const result = repository.provider.getOriginalResource(this._editorModel.uri);

			if (result) {
				return result;
			}
		}

		return null;
	}

	dispose(): void {
		this.disposables = dispose(this.disposables);

		this._editorModel = null;
		this._originalModel = null;

		if (this.diffDelayer) {
			this.diffDelayer.cancel();
			this.diffDelayer = null;
		}

		this.repositoryDisposables.forEach(d => dispose(d));
		this.repositoryDisposables.clear();
	}
}

class DirtyDiffItem {

	constructor(readonly model: DirtyDiffModel, readonly decorator: DirtyDiffDecorator) { }

	dispose(): void {
		this.decorator.dispose();
		this.model.dispose();
	}
}

export class DirtyDiffWorkbenchController implements ext.IWorkbenchContribution, IModelRegistry {

	private models: IModel[] = [];
	private items: { [modelId: string]: DirtyDiffItem; } = Object.create(null);
	private disposables: IDisposable[] = [];

	constructor(
		@IMessageService private messageService: IMessageService,
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService,
		@IEditorGroupService editorGroupService: IEditorGroupService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IInstantiationService private instantiationService: IInstantiationService
	) {
		this.disposables.push(editorGroupService.onEditorsChanged(() => this.onEditorsChanged()));
	}

	getId(): string {
		return 'git.DirtyDiffModelDecorator';
	}

	private onEditorsChanged(): void {
		// HACK: This is the best current way of figuring out whether to draw these decorations
		// or not. Needs context from the editor, to know whether it is a diff editor, in place editor
		// etc.

		const models = this.editorService.getVisibleEditors()

			// map to the editor controls
			.map(e => e.getControl())

			// only interested in code editor widgets
			.filter(c => c instanceof CodeEditor)

			// set model registry and map to models
			.map(editor => {
				const codeEditor = editor as CodeEditor;
				const controller = DirtyDiffController.get(codeEditor);
				controller.modelRegistry = this;
				return codeEditor.getModel();
			})

			// remove nulls and duplicates
			.filter((m, i, a) => !!m && !!m.uri && a.indexOf(m, i + 1) === -1);

		const newModels = models.filter(o => this.models.every(m => o !== m));
		const oldModels = this.models.filter(m => models.every(o => o !== m));

		oldModels.forEach(m => this.onModelInvisible(m));
		newModels.forEach(m => this.onModelVisible(m));

		this.models = models;
	}

	private onModelVisible(editorModel: IModel): void {
		const model = this.instantiationService.createInstance(DirtyDiffModel, editorModel);
		const decorator = new DirtyDiffDecorator(editorModel, model);

		this.items[editorModel.id] = new DirtyDiffItem(model, decorator);
	}

	private onModelInvisible(editorModel: IModel): void {
		this.items[editorModel.id].dispose();
		delete this.items[editorModel.id];
	}

	getModel(editorModel: IModel): DirtyDiffModel | null {
		const item = this.items[editorModel.id];

		if (!item) {
			return null;
		}

		return item.model;
	}

	dispose(): void {
		this.disposables = dispose(this.disposables);
		this.models.forEach(m => this.items[m.id].dispose());

		this.models = null;
		this.items = null;
	}
}

registerThemingParticipant((theme: ITheme, collector: ICssStyleCollector) => {
	const editorGutterModifiedBackgroundColor = theme.getColor(editorGutterModifiedBackground);
	if (editorGutterModifiedBackgroundColor) {
		collector.addRule(`
			.monaco-editor .dirty-diff-modified {
				border-left: 3px solid ${editorGutterModifiedBackgroundColor};
			}
			.monaco-editor .dirty-diff-modified:before {
				background: ${editorGutterModifiedBackgroundColor};
			}
		`);
	}

	const editorGutterAddedBackgroundColor = theme.getColor(editorGutterAddedBackground);
	if (editorGutterAddedBackgroundColor) {
		collector.addRule(`
			.monaco-editor .dirty-diff-added {
				border-left: 3px solid ${editorGutterAddedBackgroundColor};
			}
			.monaco-editor .dirty-diff-added:before {
				background: ${editorGutterAddedBackgroundColor};
			}
		`);
	}

	const editorGutteDeletedBackgroundColor = theme.getColor(editorGutterDeletedBackground);
	if (editorGutteDeletedBackgroundColor) {
		collector.addRule(`
			.monaco-editor .dirty-diff-deleted:after {
				border-left: 4px solid ${editorGutteDeletedBackgroundColor};
			}
			.monaco-editor .dirty-diff-deleted:before {
				background: ${editorGutteDeletedBackgroundColor};
			}
		`);
	}
});
