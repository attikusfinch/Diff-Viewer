import { useState } from 'react';
import { Image as ImageIcon, Minus, Plus } from 'lucide-react';
import type { FileContent, ImageSide, Mode } from '../types';

function formatBytes(bytes:number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024*1024 ? `${(bytes/1024).toFixed(1)} KB` : `${(bytes/1024/1024).toFixed(1)} MB`;
}

function ImagePane({asset,label,path,zoom,missing}:{asset:ImageSide|null;label:string;path:string;zoom:number|null;missing:string}) {
  const [loaded,setLoaded]=useState<{src:string|null;width:number;height:number;failed:boolean}|null>(null);
  const state=loaded?.src===asset?.dataUrl?loaded:null;
  const dimensions=state&&!state.failed?state:null;
  const failed=state?.failed;
  const message=asset?.error??(failed?'The image could not be decoded. It may be damaged.':null);
  return <section className="image-pane" aria-label={`${label} image`}>
    <header className="image-pane-heading"><span><span className={`version-dot ${label.startsWith('Original')?'before':'after'}`}/>{label}</span>
      {asset&&!message&&<span className="image-metadata">{dimensions&&`${dimensions.width} × ${dimensions.height} · `}{formatBytes(asset.bytes)} · {asset.mime?.split('/')[1].toUpperCase()}</span>}
    </header>
    <div className={`image-canvas ${zoom===null?'fit':''}`} tabIndex={0} aria-label={`Scroll ${label.toLowerCase()} image`}>
      {asset?.dataUrl&&!message?<img alt={`${label}: ${path.split('/').at(-1)}`} src={asset.dataUrl} draggable={false}
        onLoad={e=>setLoaded({src:asset.dataUrl,width:e.currentTarget.naturalWidth,height:e.currentTarget.naturalHeight,failed:false})} onError={()=>setLoaded({src:asset.dataUrl,width:0,height:0,failed:true})}
        style={zoom!==null&&dimensions?{width:dimensions.width*zoom/100,height:dimensions.height*zoom/100}:undefined}/>:
        <div className="image-empty"><ImageIcon size={28}/><strong>{message?'Image preview unavailable':missing}</strong>{message&&<p>{message}</p>}</div>}
    </div>
  </section>;
}

export default function ImagePreview({file,mode,layout}:{file:FileContent;mode:Mode;layout:'split'|'unified'}) {
  const [zoom,setZoom]=useState<number|null>(null);
  const images=file.images!;
  const comparison=mode==='diff';
  const sides=comparison?[
    {asset:images.before,label:'Original',missing:'New image · no original version'},
    {asset:images.after,label:'Modified',missing:'Image deleted'},
  ]:[{asset:images.after??images.before,label:images.after?'Modified':'Original · deleted',missing:'No image in this revision'}];
  return <div className="image-preview">
    <div className="image-toolbar"><ImageIcon size={14}/><span>Image preview</span><span className="comparison-spacer"/>
      <div className="view-switch" aria-label="Image scale"><button className={zoom===null?'active':''} aria-pressed={zoom===null} onClick={()=>setZoom(null)}>Fit</button><button className={zoom===100?'active':''} aria-pressed={zoom===100} onClick={()=>setZoom(100)}>100%</button></div>
      <button className="icon-button" aria-label="Zoom out image" disabled={zoom!==null&&zoom<=25} onClick={()=>setZoom(z=>Math.max(25,(z??100)-25))}><Minus size={14}/></button>
      <output className="image-zoom" aria-label="Image zoom">{zoom===null?'Auto':`${zoom}%`}</output>
      <button className="icon-button" aria-label="Zoom in image" disabled={zoom!==null&&zoom>=400} onClick={()=>setZoom(z=>Math.min(400,(z??100)+25))}><Plus size={14}/></button>
    </div>
    <div className={`image-panes ${comparison?layout:'single'}`}>
      {sides.map(({asset,label,missing})=><ImagePane key={label} asset={asset} label={label} path={file.path} zoom={zoom} missing={missing}/>)}
    </div>
  </div>;
}
