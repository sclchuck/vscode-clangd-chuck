import * as vscode from "vscode";
import { ClangdContext } from "./clangd-context";

export function activate(context: ClangdContext) {
  const feature = new EnhancedRenameFeature(context);
  context.subscriptions.push(feature);
}

interface RenameData {
  oldName?: string;
  newName?: string;
  references?: FileRefGroup[];
}

interface FileRefGroup {
  file: string;
  refs: ReferenceItem[];
}

interface ReferenceItem {
  location: vscode.Location;
  selected: boolean;
  isLSP: boolean;
  codePreview: string;
}

export class EnhancedRenameFeature implements vscode.Disposable {
  private context: ClangdContext;
  private renameData: RenameData = {};
  private panel?: vscode.WebviewPanel;

  constructor(context: ClangdContext) {
    this.context = context;
    this.registerCommands();
  }

  private registerCommands() {
    this.context.subscriptions.push(
      vscode.commands.registerCommand("clangd.enhancedRename", () => {
        const editor = vscode.window.activeTextEditor;
        const config = vscode.workspace.getConfiguration("clangd");
        if (
          editor?.document.languageId.match(
            /^(cpp|objective-cpp|c|objective-c|cuda-cpp)$/
          ) &&
          config.get<boolean>("enableEnhancedRename")
        ) {
          console.log("[ENHANCED RENAME] 0");
          this.performEnhancedRename();
        } else {
          console.log("[ENHANCED RENAME] 1");
          vscode.commands.executeCommand("editor.action.rename");
        }
      })
    );
  }

  private async performEnhancedRename() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const document = editor.document;
    const position = editor.selection.active;
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
      return;
    }

    const oldName = document.getText(wordRange);
    const newName = await this.showInputBox(oldName);
    if (!newName || newName === oldName) {
      return;
    }
    this.renameData.oldName = oldName;
    this.renameData.newName = newName;

    try {
      const [lspEdits, additionalRefs] = await Promise.all([
        this.getLSPEdits(document, position, newName),
        this.findAdditionalOccurrences(oldName),
      ]);

      const groupedRefs = await this.processReferences(
        lspEdits,
        additionalRefs
      );
      this.showRenamePanel(oldName, newName, groupedRefs);
    } catch (error) {
      vscode.window.showErrorMessage(`Rename failed: ${error}`);
      this.disposePanel();
    }
  }

  private async showInputBox(oldName: string): Promise<string | undefined> {
    return vscode.window.showInputBox({
      prompt: `Rename ${oldName} to:`,
      value: oldName,
      valueSelection: [0, oldName.length],
    });
  }

  private async getLSPEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string
  ) {
    return vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      "vscode.executeDocumentRenameProvider",
      document.uri,
      position,
      newName
    );
  }

  private async findAdditionalOccurrences(
    searchText: string
  ): Promise<vscode.Location[]> {
    const files = await vscode.workspace.findFiles(
      "{**/*.c,**/*.h,**/*.cpp,**/*.hpp,**/*.cc,**/*.cxx}",
      "{**/node_modules/**,**/.git/**}"
    );

    const regex = new RegExp(`\\b${this.escapeRegExp(searchText)}\\b`, "g");
    const locations: vscode.Location[] = [];

    for (const uri of files) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();

        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
          const start = doc.positionAt(match.index);
          const end = doc.positionAt(match.index + match[0].length);
          locations.push(
            new vscode.Location(uri, new vscode.Range(start, end))
          );
        }
      } catch (error) {
        console.error(`Error processing ${uri.fsPath}:`, error);
      }
    }

    return locations;
  }

  private async processReferences(
    lspEdits?: vscode.WorkspaceEdit,
    additionalRefs: vscode.Location[] = []
  ): Promise<FileRefGroup[]> {
    const lspLocations = this.convertToLocations(lspEdits);
    const filteredRefs = this.filterDuplicates(additionalRefs, lspLocations);

    const allRefs = [
      ...lspLocations.map((loc) => ({
        location: loc,
        isLSP: true,
        selected: true,
      })),
      ...filteredRefs.map((loc) => ({
        location: loc,
        isLSP: false,
        selected: false,
      })),
    ];

    return this.groupReferences(allRefs);
  }

  private groupReferences(
    refs: Array<{
      location: vscode.Location;
      isLSP: boolean;
      selected: boolean;
    }>
  ): FileRefGroup[] {
    const groups = new Map<string, ReferenceItem[]>();

    for (const ref of refs) {
      const uri = ref.location.uri.toString();
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === uri
      );
      const codePreview = doc
        ? this.getCodePreview(doc, ref.location.range)
        : "";

      const groupKey = vscode.workspace.asRelativePath(ref.location.uri);
      const item: ReferenceItem = {
        location: ref.location,
        selected: ref.selected,
        isLSP: ref.isLSP,
        codePreview: codePreview,
      };

      if (groups.has(groupKey)) {
        groups.get(groupKey)?.push(item);
      } else {
        groups.set(groupKey, [item]);
      }
    }

    return Array.from(groups.entries()).map(([file, refs]) => ({
      file,
      refs: refs.sort(
        (a, b) => a.location.range.start.line - b.location.range.start.line
      ),
    }));
  }

  private getCodePreview(
    document: vscode.TextDocument,
    range: vscode.Range
  ): string {
    const line = document.lineAt(range.start.line);
    const start = Math.max(0, range.start.character - 20);
    const end = Math.min(line.text.length, range.end.character + 20);
    return line.text.slice(start, end).replace(/\s+/g, " ");
  }

  private showRenamePanel(
    oldName: string,
    newName: string,
    groups: FileRefGroup[]
  ) {
    this.disposePanel();

    this.panel = vscode.window.createWebviewPanel(
      "clangdRenamePreview",
      `Rename ${oldName} → ${newName}`,
      {
        viewColumn: vscode.ViewColumn.Beside, // 显示在相邻编辑器列
        preserveFocus: true, // 保持原编辑器焦点
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.panel.webview.html = this.getWebviewContent(groups, oldName, newName);
    this.setupMessageHandlers();
  }

  private getWebviewContent(
    groups: FileRefGroup[],
    oldName: string,
    newName: string
  ): string {
    return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    ${this.getStyles()}
                </style>
            </head>
            <body>
                <div class="header">
                    <h3>Renaming "${oldName}" to "${newName}"</h3>
                </div>
                
                <div class="references-container">
                    ${groups
                      .map((group) => this.renderFileGroup(group))
                      .join("")}
                </div>

                <div class="actions">
                    <button class="apply-button" onclick="handleApply()">Apply Rename (${this.countSelected(
                      groups
                    )})</button>
                    <button class="cancel-button" onclick="handleCancel()">Cancel</button>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    let selectedLocations = ${JSON.stringify(
                      this.getInitialSelections(groups)
                    )};

                    function updateSelections() {
                        selectedLocations = Array.from(document.querySelectorAll('input[type="checkbox"]:checked'))
                            .map(checkbox => checkbox.dataset.location);
                        
                        document.querySelector('.apply-button').textContent = 
                            \`Apply Rename (\${selectedLocations.length})\`;
                    }

                    function handleApply() {
                      const locations = Array.from(document.querySelectorAll('input:checked'))
                        .map(checkbox => {
                          const encoded = checkbox.dataset.location;
                          return decodeURIComponent(encoded);
                        });
                      
                      vscode.postMessage({ command: 'apply', locations });
                    }



                    function handleCancel() {
                        vscode.postMessage({ command: 'cancel' });
                    }

                    document.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
                        checkbox.addEventListener('change', updateSelections);
                    });
                </script>
            </body>
            </html>
        `;
  }

  private getStyles(): string {
    return `
            body {
                font-family: var(--vscode-font-family);
                padding: 0 20px;
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
            }

            .header {
                border-bottom: 1px solid var(--vscode-editorWidget-border);
                padding: 10px 0;
                margin-bottom: 15px;
            }

            .file-group {
                margin: 15px 0;
                border: 1px solid var(--vscode-editorWidget-border);
                border-radius: 3px;
            }

            .file-header {
                padding: 8px 15px;
                background-color: var(--vscode-editorWidget-background);
                font-weight: bold;
            }

            .reference-item {
                padding: 8px 15px;
                display: flex;
                align-items: center;
                border-top: 1px solid var(--vscode-editorWidget-border);
            }

            .reference-preview {
                flex: 1;
                margin-left: 10px;
                font-family: var(--vscode-editor-font-family);
            }

            .actions {
                margin-top: 20px;
                text-align: right;
            }

            button {
                padding: 8px 16px;
                margin-left: 10px;
                border: none;
                border-radius: 3px;
                cursor: pointer;
            }

            .apply-button {
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
            }

            .cancel-button {
                background-color: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
            }
        `;
  }

  private renderFileGroup(group: FileRefGroup): string {
    return `
            <div class="file-group">
                <div class="file-header">
                    📄 ${group.file}
                </div>
                ${group.refs
                  .map((ref) => this.renderReferenceItem(ref))
                  .join("")}
            </div>
        `;
  }

  private renderReferenceItem(ref: ReferenceItem): string {
    // 修复1: 完整的HTML结构
    const safeLocation = encodeURIComponent(
      JSON.stringify(this.serializeLocation(ref.location))
    );
    return `
      <label class="reference-item">
        <input type="checkbox" 
          ${ref.selected ? "checked" : ""}
          data-location="${safeLocation}"
        >
        <span class="reference-preview">${ref.codePreview}</span>
      </label>
    `;
  }

  private setupMessageHandlers() {
    if (!this.panel) {
      return;
    }

    this.panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "apply":
          await this.applyRenameEdits(message.locations);
          this.disposePanel();
          break;
        case "cancel":
          this.disposePanel();
          break;
      }
    });
  }

  private async applyRenameEdits(serializedLocations: string[]) {
    console.log("开始应用重命名编辑:", {
      newName: this.renameData.newName,
      locations: serializedLocations,
    });

    const edit = new vscode.WorkspaceEdit();
    const newName = this.renameData.newName || "";
    let validLocations = 0;

    for (const serialized of serializedLocations) {
      console.log("处理位置:", serialized);
      const location = this.parseLocation(serialized);
      if (location) {
        // 新增文档存在性验证
        try {
          const doc = await vscode.workspace.openTextDocument(location.uri);
          const text = doc.getText(location.range);
          console.log("验证位置内容:", {
            expected: this.renameData.oldName,
            actual: text,
          });
        } catch (error) {
          console.error("文档验证失败:", error);
          continue;
        }

        console.log("edit replace", { location, newName });
        edit.replace(location.uri, location.range, newName);
        validLocations++;
      }
    }

    if (validLocations === 0) {
      vscode.window.showErrorMessage("No valid locations to rename");
      return;
    }

    try {
      const success = await vscode.workspace.applyEdit(edit);
      if (success) {
        // const saved = await Promise.all(
        //   edit
        //     .entries()
        //     .map(([uri]) =>
        //       vscode.workspace.textDocuments
        //         .find((doc) => doc.uri.toString() === uri.toString())
        //         ?.save()
        //     )
        // );
        vscode.window.showInformationMessage(
          `Renamed ${validLocations} occurrences to ${newName}`
        );
      } else {
        vscode.window.showErrorMessage("Failed to apply changes");
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Rename failed: ${error}`);
    }
  }

  private serializeLocation(location: vscode.Location): string {
    // 修复2: 增强URI规范化
    let uri = location.uri.toString();

    // 统一处理Windows路径
    if (process.platform === "win32") {
      uri = uri
        .replace(
          /^file:\/\/\/([a-z]):/i,
          (_, drive) => `file:///${drive.toUpperCase()}:`
        )
        .replace(/%3A/gi, ":")
        .replace(/\\+/g, "/");
    }

    return JSON.stringify({
      uri: uri,
      range: {
        start: location.range.start,
        end: location.range.end,
      },
    });
  }

  private removeQuotesAndEscapes(input: string): string {
    // 去除开头和结尾的双引号
    let result = input;
    if (result.startsWith('"') && result.endsWith('"')) {
      result = result.slice(1, -1);
    }

    // 去除所有的转义双引号 \"，替换为 "
    result = result.replace(/\\"/g, '"');

    return result;
  }

  private parseLocation(serialized: string): vscode.Location | null {
    try {
      // 修复3: 增强JSON解析容错
      // const sanitized = serialized
      //   .replace(/^([^{])/, "{$1")
      //   .replace(/([^}])$/, "$1}");
      const sanitized = this.removeQuotesAndEscapes(serialized);
      console.log(` sanitized: ${sanitized} `);
      const data = JSON.parse(sanitized);

      // 统一URI处理逻辑
      let uriString = data.uri;
      if (process.platform === "win32") {
        uriString = uriString
          .replace(
            /^file:\/\/([a-z]):/i,
            (_: any, drive: string) => `file:///${drive.toUpperCase()}:`
          )
          .replace(/%3A/gi, ":")
          .replace(/\\/g, "/");
      }

      console.log(` data`, data);
      const uri = vscode.Uri.parse(uriString);
      console.log(` uri`, uri);
      const range = new vscode.Range(
        new vscode.Position(data.range.start.line, data.range.start.character),
        new vscode.Position(data.range.end.line, data.range.end.character)
      );

      // 新增调试日志
      console.log("Parsed location:", {
        original: serialized,
        uri: uri.toString(),
        range: `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`,
      });

      return new vscode.Location(uri, range);
    } catch (error) {
      console.error("解析位置失败:", {
        error,
        input: serialized,
        stack: new Error().stack,
      });
      return null;
    }
  }

  private countSelected(groups: FileRefGroup[]): number {
    return groups.flatMap((g) => g.refs).filter((r) => r.selected).length;
  }

  private getInitialSelections(groups: FileRefGroup[]): string[] {
    return groups
      .flatMap((g) => g.refs)
      .filter((r) => r.selected)
      .map((r) => this.serializeLocation(r.location));
  }

  private convertToLocations(edit?: vscode.WorkspaceEdit): vscode.Location[] {
    return (
      edit
        ?.entries()
        .flatMap(([uri, edits]) =>
          edits.map((e) => new vscode.Location(uri, e.range))
        ) || []
    );
  }

  private filterDuplicates(
    additional: vscode.Location[],
    lsp: vscode.Location[]
  ): vscode.Location[] {
    return additional.filter(
      (add) =>
        !lsp.some(
          (l) =>
            l.uri.toString() === add.uri.toString() &&
            l.range.isEqual(add.range)
        )
    );
  }

  private escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private disposePanel() {
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }
  }

  dispose() {
    this.disposePanel();
  }
}
