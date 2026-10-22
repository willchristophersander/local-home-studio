import {contextBridge,ipcRenderer} from 'electron';
import type {DesktopAPI} from '../shared/model';
const api:DesktopAPI = {
 state:()=>ipcRenderer.invoke('project:state'),
 transact:tx=>ipcRenderer.invoke('project:transact',tx),
 undo:rev=>ipcRenderer.invoke('project:undo',rev),redo:rev=>ipcRenderer.invoke('project:redo',rev),
 open:()=>ipcRenderer.invoke('project:open'),saveAs:()=>ipcRenderer.invoke('project:save-as'),
 importAsset:()=>ipcRenderer.invoke('asset:import'),catalog:()=>ipcRenderer.invoke('asset:catalog'),
 downloadAsset:id=>ipcRenderer.invoke('asset:download',id),
 assetURL:file=>`homeasset://local/${encodeURIComponent(file)}`,
};
contextBridge.exposeInMainWorld('home',api);
