import * as vscode from 'vscode';
//import * as path from 'path';
//import {TextEncoder, TextDecoder} from 'util';
/**
 * Encapsulates the relevant section of settings.json
 */
class Config {
  public data:vscode.WorkspaceConfiguration;
  public constructor(scope?:vscode.ConfigurationScope|null|undefined){
    this.data = vscode.workspace.getConfiguration("regexp", scope);
  }
}
/**
 * Encapsulates multiple RegExp find/replace operations.
 * We want error messages to be shown one at a time, not all at once,
 * which is why some methods are async.
 */
class Action {
  /** Used to escape RegExp strings for literal usage */
  private static readonly literalFind = /[.*+?^${}()|[\]\\]/g;
  /** Used to escape replacement strings for literal usage */
  private static readonly literalReplace = /\$/g;
  /** Specifies the relevant section of settings.json */
  private config:Config;
  /** An array of regular expressions */
  private find:RegExp[] = [];
  /** An array of replacement strings */
  private replace:string[] = [];
  /**
   * Accumulates a list of missing actions.
   * Instead of displaying many error messages (one for each missing action),
   * we display one error message at the end using {@link Action.showMissingActions}.
   */
  private missingActions:string|undefined = undefined;
  public constructor(config:Config){
    this.config = config;
  }
  /**
   * Shows an error message with options to either abort or continue.
   * @return Promise resolving to true if the continue option is selected; false otherwise.
   */
  private static async showErrorMessage(msg:string):Promise<Boolean>{
    return (await vscode.window.showErrorMessage(msg, "Abort", "Continue"))==="Continue";
  }
  /**
   * @return the number of RegExp objects encapsulated by this Action.
   */
  public size():number {
    return this.find.length;
  }
  /**
   * Applies a sequence of regular expressions to the input string.
   */
  public apply(str:string):string {
    for (var i=0;i<this.find.length;++i){
      str = str.replace(this.find[i], this.replace[i]);
    }
    return str;
  }
  /**
   * Appends a regular expression find/replace operation to this Action.
   * @return this Action.
   */
  public appendRegExp(regexp:RegExp, replace:string):Action {
    this.find.push(regexp);
    this.replace.push(replace);
    return this;
  }
  /**
   * @param list JSON list specifying regular expressions to add to this action.
   * @param tracker Records names of referenced RegExp lists to prevent infinite loops.
   * @return Promise resolving to true on success or false if the user has selected the 'abort' option
   */
  public async appendList(list:any[], tracker?:string[]):Promise<Boolean> {
    if (!tracker){
      tracker = [];
    }
    for (const x of list){
      if (!await this.append(x, tracker.slice())){
        return false;
      }
    }
    return true;
  }
  /**
   * @param x either the name of a RegExp list specified in settings.json, or a JSON dictionary specifying a single RegExp.
   * @param tracker Records names of referenced RegExp lists to prevent infinite loops.
   * @return Promise resolving to true on success and false if the user has selected the 'abort' option
   */
  public async append(x:any, tracker?:string[]):Promise<Boolean> {
    if (typeof(x)==="string"){
      //x specifies the name of another RegExp list specified in settings.json
      if (!tracker){
        tracker = [];
      }
      if (tracker.indexOf(x)===-1){
        tracker.push(x);
        //get the RegExp list from settings.json
        var data:any[]|undefined = this.config.data[x];
        if (data && typeof(data)==="object"){
          //append the specified RegExp list
          return this.appendList(data, tracker)
        }else if (this.missingActions){
          this.missingActions = this.missingActions.concat(", ", x);
        }else{
          this.missingActions = x;
        }
      }else{
        return Action.showErrorMessage("Infinite loop detected in RegExp action: "+x);
      }
    }else{
      if (x["description"]){
        return true;
      }
      var find:string = x["find"];
      var replace:string = x["replace"];
      //check that 'find' and 'replace' properties are defined
      if (find && replace){
        var flags:string = x["flags"];
        if (!flags){
          //if flags is unspecified, then use global and multi-line
          flags = "gm";
        }
        if (x["literal"]){
          //if literal===true, then escape the RegExp find/replace strings
          find = find.replace(Action.literalFind, "\\$&");
          replace = replace.replace(Action.literalReplace, "$$$&");
        }
        //append the specified RegExp
        try{
          this.appendRegExp(new RegExp(find, flags), replace);
        }catch(err:any){
          //catches invalid RegExp errors
          return Action.showErrorMessage(err.message);
        }
      }else{
        return Action.showErrorMessage("'find' and 'replace' are required: "+JSON.stringify(x));
      }
    }
    return true;
  }
  /**
   * Shows an error message including all RegExp list references that could not be located with options to either abort or continue.
   * @return Promise resolving to true if the continue option is selected; false otherwise.
   */
  public async showMissingActions():Promise<Boolean>{
    if (this.missingActions){
      return Action.showErrorMessage(this.missingActions+" RegExp action(s) cannot be found.");
    }else{
      return true;
    }
  }
}
/**
 * Prompts the user to choose a RegExp list from settings.json. Once chosen, the list is appended to action.
 * @param config the relevant section of settings.json.
 * @param action the Action on which the selected RegExp list should be appended.
 * @return true if the user successfully chose a RegExp list; false otherwise.
 */
async function selectAndAppend(config:Config, action:Action):Promise<Boolean>{
  //Get names for all RegExp lists defined in settings.json
  const options = Object.keys(config.data).filter(
    (str:string)=>{
      //Removes irrelevant function properties as specified in vscode.WorkspaceConfiguration (get, has, inspect, update)
      return typeof(config.data[str])==="object";
    }
  );
  if (options.length===0){
    vscode.window.showErrorMessage("No RegExp actions have been defined.");
    return false;
  }else{
    //Add descriptive text to each option when specified
    const opts:vscode.QuickPickItem[] = [];
    for (const key of options){
      const arr = <any[]>config.data[key];
      var b = true;
      for (const x of arr){
        if (x["description"]){
          opts.push({
            label:key,
            description:x["description"]
          });
          b = false;
          break;
        }
      }
      if (b){
        opts.push({
          label:key
        });
      }
    }
    //Let the user select a RegExp list from the available options
    const ret = await vscode.window.showQuickPick(opts, {
      title:"RegExp Action Chooser",
      canPickMany:false
    });
    if (ret){
      //Append the selected RegExp list to the Action
      await action.append(ret.label);
      return true;
    }else{
      return false;
    }
  }
}
/**
 * Loads an action using the specified ConfigurationScope and arguments.
 * @return Promise resolving to an Action if successful, or undefined on failure.
 */
async function loadAction(scope:vscode.ConfigurationScope|undefined, args: any[]):Promise<Action|undefined>{
  //Retrieve extension settings at the selected scope
  const config = new Config(scope);
  //Construct an empty Action
  const action = new Action(config);
  if (args.length===0){
    if (!await selectAndAppend(config,action)){
      return undefined;
    }
  }else{
    //Append all arguments to the Action
    for (const x of args){
      if (!await action.appendList(x)){
        return undefined;
      }
    }
  }
  //Show named RegExp list references that could not be resolved
  if (!await action.showMissingActions()){
    return undefined;
  }
  if (action.size()==0){
    await vscode.window.showErrorMessage("RegExp action is empty!");
    return undefined;
  }
  return action;
}
/**
 * Extension entry point.
 */
export function activate(context: vscode.ExtensionContext) {
  //Escapes double quotes and backslashes in a RegExp string
  context.subscriptions.push(vscode.commands.registerCommand("regexp.stringify",
    async ()=>{
      //Get a RegExp string from the user
      var str:string|undefined = await vscode.window.showInputBox({
        title:"RegExp escape utility for JSON strings.",
        prompt:"Enter a valid regular expression.",
        placeHolder:"(.*)",
        validateInput(value:string):string|undefined {
          try{
            new RegExp(value);
            return undefined;
          }catch(err:any){
            return err.message;
          }
        }
      });
      if (str){
        //slice(1,-1) to remove quotes which are automatically placed around the result
        str = JSON.stringify(str).slice(1,-1);
        if (await vscode.window.showInformationMessage(str, "Copy")){
          //If the Copy button was pressed, set the clipboard contents
          await vscode.env.clipboard.writeText(str);
        }
      }
    }
  ));
  context.subscriptions.push(vscode.commands.registerCommand("regexp.modify.clipboard",
    async (...args: any[])=>{
      const action = await loadAction(vscode.window.activeTextEditor?.document, args);
      if (action){
        await vscode.env.clipboard.writeText(action.apply(await vscode.env.clipboard.readText()));
        await vscode.window.showInformationMessage("Clipboard contents modified.");
      }
    }
  ));
  context.subscriptions.push(vscode.commands.registerTextEditorCommand("regexp.modify.paste",
    async (editor: vscode.TextEditor, _: vscode.TextEditorEdit, ...args: any[])=>{
      const action = await loadAction(editor.document, args);
      if (action){
        const str = action.apply(await vscode.env.clipboard.readText());
        //must initiate a new edit because this method is executing asynchronously
        if (!await editor.edit(
          (edit:vscode.TextEditorEdit) => {
            for (const selection of editor.selections){
              edit.replace(selection, str)
            }
          }
        )){
          await vscode.window.showInformationMessage("Operation failed.");
        }
      }
    }
  ));
  context.subscriptions.push(vscode.commands.registerTextEditorCommand("regexp.modify.selections",
    async (editor: vscode.TextEditor, _: vscode.TextEditorEdit, ...args: any[])=>{
      const action = await loadAction(editor.document, args);
      if (action){
        //must initiate a new edit because this method is executing asynchronously
        if (!await editor.edit(
          (edit:vscode.TextEditorEdit) => {
            for (const selection of editor.selections){
              edit.replace(selection, action.apply(editor.document.getText(selection)))
            }
          }
        )){
          await vscode.window.showInformationMessage("Operation failed.");
        }
      }
    }
  ));
  context.subscriptions.push(vscode.commands.registerTextEditorCommand("regexp.modify.document",
    async (editor: vscode.TextEditor, _: vscode.TextEditorEdit, ...args: any[])=>{
      const action = await loadAction(editor.document, args);
      if (action){
        const doc = editor.document;
        const lastLine = doc.lineCount-1;
        const r = new vscode.Range(0, 0, lastLine, doc.lineAt(lastLine).rangeIncludingLineBreak.end.character);
        const str = action.apply(doc.getText());
        //must initiate a new edit because this method is executing asynchronously
        if (!await editor.edit(
          (edit:vscode.TextEditorEdit) => {
            edit.replace(r, str);
          }
        )){
          await vscode.window.showInformationMessage("Operation failed.");
        }
      }
    }
  ));
  context.subscriptions.push(vscode.commands.registerCommand("regexp.modify.documents",
    async (...args: any[])=>{

    }
  ));
  context.subscriptions.push(vscode.commands.registerCommand("regexp.modify.workspaces",
    async (...args: any[])=>{

    }
  ));

  /*
  context.subscriptions.push(vscode.commands.registerTextEditorCommand('replacerules.runRule', runSingleRule));
  context.subscriptions.push(vscode.commands.registerTextEditorCommand('replacerules.runRuleset', runRuleset));
  context.subscriptions.push(vscode.commands.registerTextEditorCommand('replacerules.pasteAndReplace', pasteReplace));
  context.subscriptions.push(vscode.commands.registerCommand('replacerules.stringifyRegex', stringifyRegex));

    how to get configuration properties for this extension {
      vscode.workspace.getConfiguration("RegExp", scope?: Uri | TextDocument): WorkspaceConfiguration
      configObject["label"] to access the regex list with the given label
      scope specifies where to get the configuration from; probably use TextDocument
      might have to directly use vscode.workspace.fs to edit files if openTextDocument() doesn't work as expected
    }
    
    use these methods to read and write clipboard contents {
      vscode.env.clipboard.readText(): Thenable<string>
      vscode.env.clipboard.writeText(value: string): Thenable<void>
    }

    how to get TextDocument objects {
      get all available text documents
        vscode.workspace.textDocuments: TextDocument[]
      get workspaces files optionally filtered with GlobPatterns
        vscode.workspace.findFiles(include: GlobPattern, exclude?: GlobPattern | null): Thenable<Uri[]>
      retrieve TextDocument from Uri
        vscode.workspace.openTextDocument(uri: Uri): Thenable<TextDocument>
    }
    
    additional properties to filter by {
      regex to filter by filename
        vscode.TextDocument.fileName: string
      array to filter by languageId
        vscode.TextDocument.languageId: string
    }
    
    resource editing {
      applies a WorkspaceEdit object
        vscode.workspace.applyEdit(edit: WorkspaceEdit): Thenable<boolean>
      queue an edit action which replaces a range in the given Uri with newText
        WorkspaceEdit.replace(uri: Uri, range: Range, newText: string): void
    }

  */
}
export function deactivate(){}