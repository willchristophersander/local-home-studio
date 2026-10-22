import {listPolyHaven,downloadPolyHaven,importLocalAsset} from '../assets';
// A utility process keeps parsing and asset conversion away from the UI/main loop.
const parent = (process as unknown as {parentPort:{on:(event:string,cb:(event:{data:any})=>void)=>void;postMessage:(message:unknown)=>void}}).parentPort;
parent.on('message',async ({data})=>{
 try {
   const result = data.kind==='catalog' ? await listPolyHaven() : data.kind==='download' ? await downloadPolyHaven(data.id,data.directory) : await importLocalAsset(data.file,data.directory);
   parent.postMessage({ok:true,result});
 }catch(error){ parent.postMessage({ok:false,error:error instanceof Error?error.message:String(error)}); }
});
