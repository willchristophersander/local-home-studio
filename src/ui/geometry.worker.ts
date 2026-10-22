import {buildGeometry} from '../geometry';
import type {Project} from '../shared/model';
self.onmessage = (event:MessageEvent<Project>) => {
  try { self.postMessage(buildGeometry(event.data)); }
  catch(error) { self.postMessage({revision:event.data.revision,meshes:[],diagnostics:[{code:'GEOMETRY_ERROR',message:String(error)}]}); }
};
