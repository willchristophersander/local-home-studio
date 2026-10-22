import {app,BrowserWindow,ipcMain,dialog,protocol,net,utilityProcess,Menu} from 'electron';
import {mkdir,cp,rename,rm,realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ProjectStore} from '../core';
import {createSample} from '../core/sample';
import {validateGeometry} from '../geometry';
import type {Transaction,AppState} from '../shared/model';

protocol.registerSchemesAsPrivileged([{scheme:'homeasset',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
let win:BrowserWindow;
let store:ProjectStore;
let folder='';
let assetJob=false;
const root=path.resolve(__dirname,'..');
function state():AppState {return {...store.getState(),location:folder};}
function assertSender(event:Electron.IpcMainInvokeEvent){
 if(event.sender!==win.webContents || event.senderFrame!==win.webContents.mainFrame) throw new Error('Untrusted application frame.');
}
function handle(name:string,fn:(...args:any[])=>any){ipcMain.handle(name,(event,...args)=>{assertSender(event);return fn(...args);});}
async function openStore(directory:string){
 await mkdir(path.join(directory,'assets'),{recursive:true});
 const next = new ProjectStore(path.join(directory,'project.sqlite'),createSample(),validateGeometry);
 store?.close();store=next;folder=directory;
}
async function worker(kind:string,args:Record<string,unknown>={}):Promise<any>{
 if(assetJob) throw new Error('An asset job is already running. Please wait for it to finish.');
 assetJob=true;
 return new Promise((resolve,reject)=>{
   const child=utilityProcess.fork(path.join(__dirname,'asset-worker.cjs'),[],{serviceName:'Asset importer',stdio:'pipe'});
   let finished=false;
   const finish=(error?:Error,value?:unknown)=>{if(finished)return;finished=true;clearTimeout(timer);assetJob=false;child.kill();error?reject(error):resolve(value);};
   const timer=setTimeout(()=>finish(new Error('Asset operation timed out. The project was not changed.')),180_000);
   child.on('spawn',()=>child.postMessage({kind,...args}));
   child.on('message',message=>message.ok?finish(undefined,message.result):finish(new Error(message.error)));
   child.on('exit',code=>{if(!finished)finish(new Error(`Asset worker stopped (${code}).`));});
 });
}
app.whenReady().then(async()=>{
 const data=process.env.HOME_STUDIO_DATA || app.getPath('userData');
 await openStore(path.join(data,'Studio.homeproject'));
 protocol.handle('homeasset',async request=>{
   try{
     const url=new URL(request.url);const filename=decodeURIComponent(url.pathname.slice(1));
     if(url.hostname!=='local'||!/^[a-f0-9]{64}\.glb$/.test(filename))return new Response('Invalid asset',{status:403});
     const assetRoot=await realpath(path.join(folder,'assets'));const resolved=await realpath(path.join(assetRoot,filename));
     if(!resolved.startsWith(assetRoot+path.sep))return new Response('Invalid asset',{status:403});
     return net.fetch(pathToFileURL(resolved).href);
   }catch{return new Response('Missing asset',{status:404});}
 });
 handle('project:state',state);
 handle('project:transact',(tx:Transaction)=>{store.transact({...tx,source:'user',allowedIds:undefined});return state();});
 handle('project:undo',(rev:number)=>{store.undo(rev);return state();});
 handle('project:redo',(rev:number)=>{store.redo(rev);return state();});
 handle('project:open',async()=>{
   if(assetJob)throw new Error('Wait for the asset operation before switching projects.');
   const pick=await dialog.showOpenDialog(win,{title:'Open a .homeproject folder',properties:['openDirectory']});
   if(pick.canceled)return null;
   const dir=pick.filePaths[0];
   if(!existsSync(path.join(dir,'project.sqlite')))throw new Error('Choose a project folder containing project.sqlite.');
   if(path.resolve(dir)!==path.resolve(folder))await openStore(dir);
   return state();
 });
 handle('project:save-as',async()=>{
   if(assetJob)throw new Error('Wait for the asset operation before saving a copy.');
   const pick=await dialog.showSaveDialog(win,{title:'Save a portable project copy',defaultPath:`${store.getState().project.name}.homeproject`});
   if(pick.canceled||!pick.filePath)return null;
   const dest=pick.filePath;
   if(existsSync(dest))throw new Error('Please choose a new folder name. Existing projects are never overwritten by Save a copy.');
   const stage=`${dest}.tmp-${Date.now()}`;
   try{
     await mkdir(stage,{recursive:true});
     await cp(path.join(folder,'assets'),path.join(stage,'assets'),{recursive:true});
     await store.saveCopy(path.join(stage,'project.sqlite'));
     await rename(stage,dest);
     return dest;
   }catch(error){await rm(stage,{recursive:true,force:true});throw error;}
 });
 handle('asset:catalog',()=>worker('catalog'));
 handle('asset:import',async()=>{
   const pick=await dialog.showOpenDialog(win,{title:'Import glTF / GLB',filters:[{name:'3D model',extensions:['glb','gltf']}],properties:['openFile']});
   if(pick.canceled)return null;
   return worker('import',{file:pick.filePaths[0],directory:path.join(folder,'assets')});
 });
 handle('asset:download',(id:string)=>{
   if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(id))throw new Error('Invalid catalog item.');
   return worker('download',{id,directory:path.join(folder,'assets')});
 });
 win=new BrowserWindow({width:1480,height:960,minWidth:1080,minHeight:720,title:'Local Home Studio',backgroundColor:'#f4f4ef',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.webContents.on('will-navigate',event=>event.preventDefault());
 win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
 Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Local Home Studio',submenu:[{role:'about'},{type:'separator'},{role:'quit'}]},{label:'Edit',submenu:[{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'View',submenu:[{role:'togglefullscreen'},{role:'toggleDevTools'}]}]));
 const proof=process.env.HOME_STUDIO_PROOF_GLB;
 if(proof){
   const filename=path.basename(proof);
   if(!/^[a-f0-9]{64}\.glb$/.test(filename)) throw new Error('Proof GLB must be a sha256 content name.');
   await cp(proof,path.join(folder,'assets',filename));
 }
 await win.loadFile(path.join(root,'dist','index.html'));
 if(proof) await proveImportedGlb(path.basename(proof));
});
async function proveImportedGlb(filename:string){
 const notes:string[]=[];
 win.webContents.on('console-message',details=>notes.push(details.message));
 const started=Date.now();
 while(Date.now()-started<20_000){
   await win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('home-load-glb',{detail:${JSON.stringify(filename)}}))`);
   await new Promise(resolve=>setTimeout(resolve,400));
   const reading=JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({status:document.querySelector('[data-testid=marker-status]')?.textContent||'',error:document.querySelector('[data-testid=error]')?.textContent||'',title:document.title,revision:document.querySelector('[data-testid=revision]')?.textContent||''})`)) as {status:string;error:string;title:string;revision:string};
   if(reading.status||reading.error){
     console.log(JSON.stringify({electron:true,file:filename,...reading,console:notes.slice(-20)}));
     app.exit(reading.status.startsWith('Marker ')&&!reading.error?0:1);
     return;
   }
 }
 console.log(JSON.stringify({electron:true,file:filename,timedOut:true,console:notes.slice(-30)}));
 app.exit(1);
}
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{try{store?.close();}catch{}});
