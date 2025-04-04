import * as vscode from "vscode";
import { ClangdContext } from "./clangd-context";

export function activate(context: ClangdContext) {
  const feature = new AutoFormatFeature(context);
  context.subscriptions.push(feature);
}

class AutoFormatFeature {
  private context: ClangdContext;
  private disposable: vscode.Disposable;

  constructor(context: ClangdContext) {
    this.context = context;

    // Register configuration settings
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) =>
        this.onConfigurationChanged(event)
      )
    );

    // Register text document change listener
    this.disposable = vscode.workspace.onDidChangeTextDocument(
      this.handleTextDocumentChange,
      this
    );

    context.subscriptions.push(this.disposable);

    // Register configuration command
    context.subscriptions.push(
      vscode.commands.registerCommand(
        "clangd.configureAutoFormatting",
        this.configureAutoFormatting,
        this
      )
    );
  }

  private async configureAutoFormatting() {
    const config = vscode.workspace.getConfiguration("clangd");

    const options = [
      {
        label: "Format on semicolon",
        picked: config.get<boolean>("formatOnSemicolon"),
        description:
          "Automatically format the current line when semicolon is typed",
      },
      {
        label: "Format on closing brace",
        picked: config.get<boolean>("formatOnCloseBrace"),
        description:
          "Automatically format contents inside curly braces when closing brace is typed",
      },
    ];

    const selected = await vscode.window.showQuickPick(options, {
      canPickMany: true,
      placeHolder: "Select auto-formatting options",
    });

    if (!selected) {
      return;
    }

    await config.update(
      "formatOnSemicolon",
      selected.some((item) => item.label === "Format on semicolon"),
      vscode.ConfigurationTarget.Global
    );

    await config.update(
      "formatOnCloseBrace",
      selected.some((item) => item.label === "Format on closing brace"),
      vscode.ConfigurationTarget.Global
    );

    vscode.window.showInformationMessage("Auto-formatting settings updated");
  }

  private onConfigurationChanged(event: vscode.ConfigurationChangeEvent) {
    if (
      event.affectsConfiguration("clangd.formatOnSemicolon") ||
      event.affectsConfiguration("clangd.formatOnCloseBrace")
    ) {
      // Configuration changed, we don't need to do anything special here
      // as we check configuration values when handling document changes
    }
  }

  private async handleTextDocumentChange(
    event: vscode.TextDocumentChangeEvent
  ) {
    // Only process C/C++ files
    if (!this.isCppFile(event.document)) {
      return;
    }

    // Get configuration
    const config = vscode.workspace.getConfiguration("clangd");
    const formatOnSemicolon = config.get<boolean>("formatOnSemicolon");
    const formatOnCloseBrace = config.get<boolean>("formatOnCloseBrace");

    // If both features are disabled, return early
    if (!formatOnSemicolon && !formatOnCloseBrace) {
      return;
    }

    // Make sure there's an active editor
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== event.document) {
      return;
    }

    // Process each change
    for (const change of event.contentChanges) {
      const charTyped = change.text;

      // Format on semicolon
      if (formatOnSemicolon && charTyped === ";") {
        await this.formatCurrentLine(editor);
      }

      // Format on closing brace
      if (formatOnCloseBrace && charTyped === "}") {
        await this.formatInsideBraces(editor);
      }
    }
  }

  private isCppFile(document: vscode.TextDocument): boolean {
    return (
      document.languageId === "cpp" ||
      document.languageId === "c" ||
      document.languageId === "objective-c" ||
      document.languageId === "objective-cpp"
    );
  }

  private async formatCurrentLine(editor: vscode.TextEditor): Promise<void> {
    const position = editor.selection.active;
    const line = position.line;

    // Define range for the current line
    const range = new vscode.Range(
      new vscode.Position(line, 0),
      new vscode.Position(line, editor.document.lineAt(line).text.length)
    );

    // Format the range
    try {
      await vscode.commands.executeCommand("editor.action.formatSelection", {
        range,
      });
    } catch (error) {
      console.error("Error formatting current line:", error);
    }
  }

  private async formatInsideBraces(editor: vscode.TextEditor): Promise<void> {
    // Find matching opening brace
    const position = editor.selection.active;
    const openBracePosition = this.findMatchingOpenBrace(editor, position);

    if (!openBracePosition) {
      return;
    }

    // Define range from open brace to close brace
    const range = new vscode.Range(openBracePosition, position);

    // Format the range
    try {
      await vscode.commands.executeCommand("editor.action.formatSelection", {
        range,
      });
    } catch (error) {
      console.error("Error formatting inside braces:", error);
    }
  }

  private findMatchingOpenBrace(
    editor: vscode.TextEditor,
    closeBracePosition: vscode.Position
  ): vscode.Position | null {
    // Get document text up to the closing brace
    const text = editor.document.getText(
      new vscode.Range(new vscode.Position(0, 0), closeBracePosition)
    );

    // Simple brace matching (for more accurate results, consider using a parser)
    let braceLevel = 1;
    for (let i = text.length - 1; i >= 0; i--) {
      if (text[i] === "}") {
        braceLevel++;
      } else if (text[i] === "{") {
        braceLevel--;
        if (braceLevel === 0) {
          // Found matching open brace, calculate position
          const position = editor.document.positionAt(i);
          return position;
        }
      }
    }

    return null;
  }

  dispose() {
    this.disposable.dispose();
  }
}
