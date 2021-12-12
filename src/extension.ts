import * as vscode from 'vscode';
import * as path from 'path';
//import {TextEncoder, TextDecoder} from 'util';
/**
 * Encapsulates the relevant section of settings.json
 */
class Config {
  public data:vscode.WorkspaceConfiguration;
  public resource:vscode.Uri|undefined;
  public constructor(scope?:vscode.ConfigurationScope|null|undefined){
    if (scope===null || scope===undefined){
      scope = vscode.window.activeTextEditor?.document;
    }
    this.data = vscode.workspace.getConfiguration("regexp.actions", scope);
    if (scope===undefined || scope instanceof vscode.Uri){
      this.resource = scope;
    }else{
      this.resource = scope.uri;
    }
  }
}
class Templates {
  private dict:Record<string,string> = {};
  private resource:vscode.Uri|undefined;
  constructor(resource:vscode.Uri|undefined){
    this.resource = resource;
  }
  public async get(key:string, reload?:boolean):Promise<string>{
    var ret:string = this.dict[key];
    if (reload || !ret){
      ret = await this.load(key);
      //Only cache expansions when the key length is less than 64
      if (key.length<64){
        this.dict[key] = ret;
      }
    }
    return ret;
  }
  private async load(substr:string):Promise<string>{
    const i = substr.indexOf(':');
    if (i==-1){
      switch (substr){
        case "workspaceFolder":{
          if (!this.resource){ return ""; }
          const v = vscode.workspace.getWorkspaceFolder(this.resource)?.uri.fsPath;
          return v || "";
        }
        case "workspaceFolderBasename":{
          if (!this.resource){ return ""; }
          const v = vscode.workspace.getWorkspaceFolder(this.resource)?.uri.fsPath;
          return v?path.basename(v):"";
        }
        case "file":{
          return this.resource?.fsPath || "";
        }
        case "relativeFile":{
          if (!this.resource){ return ""; }
          const v = vscode.workspace.getWorkspaceFolder(this.resource)?.uri.fsPath;
          return v?path.relative(v, this.resource.fsPath):"";
        }
        case "fileDirname":{
          return this.resource?path.dirname(this.resource.fsPath):"";
        }
        case "relativeFileDirname":{
          return this.resource?path.basename(path.dirname(this.resource.fsPath)):"";
        }
        case "fileBasename":{
          return this.resource?path.basename(this.resource.fsPath):"";
        }
        case "fileBasenameNoExtension":{
          return this.resource?path.basename(this.resource.fsPath, path.extname(this.resource.fsPath)):"";
        }
        case "fileExtname":{
          return this.resource?path.extname(this.resource.fsPath):"";
        }
        case "lineNumber":{
          const v = vscode.window.activeTextEditor?.selection.start.line;
          return v?(v+1).toString():"";
        }
        case "selectedText":{
          const editor = vscode.window.activeTextEditor;
          return editor?editor.document.getText(editor.selection):"";
        }
        case "pathSeparator":{
          return path.sep;
        }
        case "clipboard":{
          return await vscode.env.clipboard.readText();
        }
        case "cwd":{
          return process.cwd();
        }
        case "version":{
          return vscode.version;
        }
        case "defaultBuildTask":{
          /* TODO
            get the default build task
            add toUpperCase and toLowerCase transforms for replacements
              $L makes everything after it lowercase
              $U makes everything after it uppercase
              $R resets both flags
              these flags do not recurse down into ${} func calls
            add way to invoke further replacements on subexpressions
              ${regexp:name:text}
              make $ escape } so that } can be included in text if necessary
              have reserved name 'this' to optimize Templates
                edit package.json to prevent action name 'this'
            make replace property optional in settings (default to the empty string)
            make command that takes input text and args, returning the replaced text without editing any files (regexp.modify.string)
            add support for recursing into named capturing group replacements. e.g, we could use $<key:$1>
            add command to take text from one file and place it in another (regexp.transfer)
              params
                inGlobInclude, inGlobExclude, inNameRegex
                outGlobInclude, outGlobExclude, outNameRegex
                inMatchers = array of dictionaries = [
                  {
                    "find":"^ *(\w+) *= *(\w+) *$",
                    "groups":[
                      {
                        "name":"var_$1",
                        "value":"${regexp:formatValue:$2}"
                      },
                      ...
                    ]
                  },
                  ...
                ]
                outMatchers = standard RegExp format = [
                  {
                    "find":"^( *)(\w+)( *= *)\w*( *)$",
                    "replace":"$1$2$3$<var_$2>$4"
                  },
                  ...
                ]
              if no globs/nameRegex is given, we should only mess with the active text editor
              might as well have $ escape the closing > inside recursed named group replacement expansions
              essentially doing regexp.modify.workspaces with an additional step of collecting named capturing groups
              
          */
          
        }
        default:{
          //@ts-ignore
          const x = vscode.env[substr];
          if (typeof(x)==="string"){
            return x;
          }
        }
      }
    }else{
      const key = substr.substring(0,i);
      const value = substr.substring(i+1);
      switch (key){
        case "workspaceFolder":{
          const folders = vscode.workspace.workspaceFolders;
          if (folders){
            for (const f of folders){
              if (f.name===value){
                return f.uri.fsPath;
              }
            }
          }
          return "";
        }
        case "env":{
          return process.env[value] || "";
        }
        case "config":{
          const j = value.lastIndexOf('.');
          var v:string|undefined;
          if (j==-1){
            v = vscode.workspace.getConfiguration(undefined, this.resource).get(value);
          }else{
            v = vscode.workspace.getConfiguration(value.substring(0,j), this.resource).get(value.substring(j+1));
          }
          return v || "";
        }
        case "command":{
          const j = value.indexOf(':');
          if (j==-1){
            const v = await vscode.commands.executeCommand(value);
            return typeof(v)==="string"?v:"";
          }else{
            const v = await vscode.commands.executeCommand(value.substring(0,j), vscode.workspace.getConfiguration("regexp.args", this.resource)[value.substring(j+1)]);
            return typeof(v)==="string"?v:"";
          }
        }
      }
    }
    return "";
  }
}
class FindReplace {
  public find:RegExp;
  public replace:string;
  public literal:boolean = false;
  constructor(find:RegExp, replace:string, literal?:boolean){
    this.find = find;
    this.replace = replace;
    if (literal){
      this.literal = true;
    }
  }
  private static readonly numMatcher = /\d/;
  /**
   * This method formats a replacement string based on the data from a given RegExp match.
   */
  public async format(match:RegExpMatchArray, templates:Templates):Promise<string> {
    if (this.literal || this.replace.length==0){
      return this.replace;
    }
    const len = this.replace.length;
    var i = 0;
    var c:string;
    const func = async (returnOnBracket:boolean):Promise<string> => {
      var ret = "";
      for (;i<len;++i){
        c = this.replace.charAt(i);
        if (c==='$'){
          if (++i<len){
            switch (this.replace.charAt(i)){
              case '$':{
                ret+='$';
                break;
              }
              case '&':{
                ret+=match[0];
                break;
              }
              case '`':{
                ret+=match.input!.substring(0, match.index!);
                break;
              }
              case '\'':{
                ret+=match.input!.substring(match[0].length+match.index!);
                break;
              }
              case '<':{
                const j = i;
                i = this.replace.indexOf('>', i+1)
                if (i==-1){
                  i = j;
                }else{
                  if (match.groups){
                    const v = match.groups[this.replace.substring(j+1,i)];
                    if (v){ ret+=v; }
                  }
                }
                break;
              }
              case '{':{
                ++i;
                let innerStr = await func(true);
                let reload = false;
                if (innerStr.length>0 && innerStr.charAt(0)==='@'){
                  reload = true;
                  innerStr = innerStr.substring(1);
                }
                ret+=await templates.get(innerStr, reload);
                break;
              }
              default:{
                const j = i;
                for (;i<len;++i){
                  if (!FindReplace.numMatcher.test(this.replace.charAt(i))){
                    break;
                  }
                }
                if (i!=j){
                  const v = match[parseInt(this.replace.substring(j,i), 10)];
                  if (v){ ret+=v; }
                }
                --i;
              }
            }
          }
        }else if (returnOnBracket && c==='}'){
          break;
        }else{
          ret+=c;
        }
      }
      return ret;
    };
    return await func(false);
  }
}
class Replacement {
  public range:vscode.Range;
  public text:string;
  constructor(range:vscode.Range, text:string){
    this.range = range;
    this.text = text;
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
  /** Specifies the relevant section of settings.json */
  private config:Config;
  /** Keeps track of expanded replacements to reduce the total number of expansions. */
  private templates:Templates;
  /** An array of RegExp find/replace operations */
  private arr:FindReplace[] = [];
  /**
   * Accumulates a list of missing actions.
   * Instead of displaying many error messages (one for each missing action),
   * we display one error message at the end using {@link Action.showMissingActions}.
   */
  private missingActions:string|undefined = undefined;
  public constructor(config:Config){
    this.config = config;
    this.templates = new Templates(this.config.resource);
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
    return this.arr.length;
  }
  /**
   * Resets the template with the given resource.
   */
  public resetTemplate(resource?:vscode.Uri):void{
    this.templates = new Templates(resource || this.config.resource);
  }
  /**
   * Applies a sequence of regular expressions to the input string.
   */
  public async apply(str:string):Promise<string> {
    for (const x of this.arr){
      var ret = "";
      var i = 0;
      for (const m of str.matchAll(x.find)){
        ret+=str.substring(i, m.index!);
        i = m.index!+m[0].length;
        ret+=await x.format(m, this.templates);
      }
      ret+=str.substring(i);
      str = ret;
    }
    return str;
  }
  /**
   * Applies a sequence of regular expressions to the specified Range of the given TextEditor.
   * @return Promise<Boolean> indicating success.
   */
  public async applyToEditor(editor:vscode.TextEditor):Promise<Boolean> {
    const doc = editor.document;
    for (const x of this.arr){
      const text = doc.getText();
      const replacements:Replacement[] = [];
      for (const match of text.matchAll(x.find)){
        replacements.push(new Replacement(new vscode.Range(doc.positionAt(match.index!), doc.positionAt(match.index!+match[0].length)), await x.format(match, this.templates)));
      }
      if (!await editor.edit(
        (editBuilder:vscode.TextEditorEdit) => {
          for (const r of replacements){
            editBuilder.replace(r.range, r.text);
          }
        },
        {
          undoStopBefore:false,
          undoStopAfter:false
        }
      )){
        return false;
      }
    }
    return true;
  }
  /**
   * Appends a regular expression find/replace operation to this Action.
   * @return this Action.
   */
  public appendRegExp(op:FindReplace):Action {
    this.arr.push(op);
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
        }else if (flags.indexOf('g')==-1){
          flags+='g';
        }
        if (x["literal"]){
          //if literal===true, then escape the RegExp find/replace strings
          find = find.replace(Action.literalFind, "\\$&");
        }
        //append the specified RegExp
        try{
          this.appendRegExp(new FindReplace(new RegExp(find, flags), replace, x["literal"]));
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
  //Check that action is non-empty
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
        await vscode.env.clipboard.writeText(await action.apply(await vscode.env.clipboard.readText()));
        await vscode.window.showInformationMessage("Clipboard contents modified.");
      }
    }
  ));
  context.subscriptions.push(vscode.commands.registerTextEditorCommand("regexp.modify.paste",
    async (editor: vscode.TextEditor, _: vscode.TextEditorEdit, ...args: any[])=>{
      const action = await loadAction(editor.document, args);
      if (action){
        const str = await action.apply(await vscode.env.clipboard.readText());
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
        const replacements:Replacement[] = [];
        for (const selection of editor.selections){
          replacements.push(new Replacement(selection, await action.apply(editor.document.getText(selection))));
        }
        if (!await editor.edit(
          (editBuilder:vscode.TextEditorEdit) => {
            for (const r of replacements){
              editBuilder.replace(r.range, r.text);
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
      const doc = editor.document;
      const action = await loadAction(doc, args);
      if (action && !await action.applyToEditor(editor)){
        await vscode.window.showInformationMessage("Operation failed.");
      }
    }
  ));
  context.subscriptions.push(vscode.commands.registerCommand("regexp.modify.documents",
    async (...args: any[])=>{
      //TODO
    }
  ));
  context.subscriptions.push(vscode.commands.registerCommand("regexp.modify.workspaces",
    async (...args: any[])=>{
      //TODO
    }
  ));
  /*
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