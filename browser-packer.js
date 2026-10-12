/* Browser-local packaging. No media or firmware build requests leave this page. */
(()=>{
  const from64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  const hex=b=>Array.from(b,v=>v.toString(16).padStart(2,'0')).join('');
  const sha=async b=>new Uint8Array(await crypto.subtle.digest('SHA-256',b));
  const crcTable=Array.from({length:256},(_,i)=>{let c=i<<24;for(let j=0;j<8;j++)c=(c<<1)^((c&0x80000000)?0x04c11db7:0);return c>>>0});
  function opusPackets(data){
    const view=new DataView(data.buffer,data.byteOffset,data.byteLength),packets=[];let at=0,seq=0,serial,pending=[],ended=false;
    while(at<data.length){
      if(ended||at+27>data.length||String.fromCharCode(...data.subarray(at,at+5))!=='OggS\0')throw Error('音频 Ogg 页面不完整');
      const count=data[at+26],head=at+27+count;if(head>data.length)throw Error('音频 Ogg 页面截断');
      let end=head;for(let i=at+27;i<head;i++)end+=data[i];if(end>data.length)throw Error('音频 Ogg 页面截断');
      let crc=0;for(let i=at;i<end;i++){const b=i>=at+22&&i<at+26?0:data[i];crc=((crc<<8)^crcTable[((crc>>>24)^b)&255])>>>0}
      if(crc!==view.getUint32(at+22,true))throw Error('音频 CRC 校验失败');
      const flags=data[at+5],id=view.getUint32(at+14,true);
      if((flags&~7)||view.getUint32(at+18,true)!==seq||(serial!==undefined&&id!==serial)||Boolean(flags&1)!==Boolean(pending.length)||Boolean(flags&2)!==(seq===0))throw Error('音频 Ogg 流顺序错误');
      serial=id;seq++;let pos=head;
      for(let i=at+27;i<head;i++){const len=data[i];for(let j=0;j<len;j++)pending.push(data[pos++]);if(pending.length>65536)throw Error('音频数据包过大');if(len<255){packets.push(Uint8Array.from(pending));pending=[]}}
      ended=Boolean(flags&4);at=end;
    }
    const h=packets[0],tags=packets[1];
    if(pending.length||!ended||packets.length<3||h.length!==19||new TextDecoder().decode(h.subarray(0,8))!=='OpusHead'||h[8]!==1||h[9]!==1||h[16]||h[17]||h[18]||new TextDecoder().decode(tags.subarray(0,8))!=='OpusTags')throw Error('仅支持无增益的单声道 Opus');
    for(const p of packets.slice(2)){
      if(!p.length||p.length>1500)throw Error('音频包大小错误');
      const config=p[0]>>3,code=p[0]&3;
      const samples=config>=16?120<<(config&3):config>=12?480<<(config&1):(config&3)===3?2880:480<<(config&3);
      const count=code===0?1:code<3?2:p.length>1?p[1]&63:0;
      if(samples*count!==960)throw Error('音频必须使用 20 ms 数据包');
    }
    return packets.slice(2);
  }
  function recordImage(tracks,capacity){
    const out=new Uint8Array(0x500000).fill(255),view=new DataView(out.buffer);let offset=0,frame=0;
    for(const packets of tracks){
      if(frame)frame++;
      for(const p of packets){
        if(frame>=45000)throw Error('包含曲目间隔的总时长超过 15 分钟');
        const size=(8+p.length+3)&~3;if(offset%4096+size>4096)offset=(offset+4095)&~4095;
        if(offset+size>capacity)throw Error('音频日志空间不足，请减少音乐');
        let crc=0xffff;for(const b of p){crc^=b<<8;for(let bit=0;bit<8;bit++)crc=((crc<<1)^((crc&0x8000)?0x1021:0))&65535}
        [0xf10a,frame,p.length,crc].forEach((v,i)=>view.setUint16(offset+i*2,v,true));out.set(p,offset+8);offset+=size;frame++;
      }
    }
    return out;
  }
  async function sealApp(app){
    if(app[0]!==0xe9||app[23]!==1)throw Error('不支持的固件模板');
    const view=new DataView(app.buffer,app.byteOffset,app.byteLength);let at=24,crc=0xef;
    for(let i=0;i<app[1];i++){
      if(at+8>app.length)throw Error('固件段截断');
      const size=view.getUint32(at+4,true);at+=8;if(at+size>app.length)throw Error('固件段越界');
      for(let end=at+size;at<end;at++)crc^=app[at];
    }
    const checksum=at|15,digest=checksum+1;
    if(digest+32!==app.length)throw Error('固件校验位置错误');
    app[checksum]=crc;app.set(await sha(app.subarray(0,digest)),digest);
  }
  async function build(files,manifest,progress=()=>{}){
    const step=async label=>{progress(label);await new Promise(resolve=>setTimeout(resolve,0))};
    if(!crypto.subtle)throw Error('请使用 HTTPS 或本地文件打开编辑器');
    const t=globalThis.FolomanFirmwareTemplates,kind=manifest.type;
    if(!t||t.version!==1)throw Error('缺少固件模板，请完整上传网站文件');
    if(!['blank','music','mixed'].includes(kind))throw Error('未知磁带类型');
    const items=manifest.audio.files;if((kind==='blank'&&items.length)||(kind!=='blank'&&!items.length))throw Error('磁带类型与音频不匹配');
    const get=name=>{const f=files.find(f=>f.name===name);if(!f)throw Error('缺少资源：'+name);return f.data};
    await step('检查固件模板');
    const v=kind==='music'?t.music:t.record,prefix=from64(t.prefix),app=from64(v.image);
    if(prefix.length!==0x10000||app.length!==v.size||app.length>0x2f0000||hex(await sha(prefix))!==t.prefixSha256||hex(await sha(app))!==v.sha256)throw Error('固件模板校验失败');
    await step('写入封面与文字');
    for(const [name,offset,size] of [['shell-back.rgb565',0,153600],['shell-front.bgra',971224,307200],['sticker.bgra',1455948,307200]]){
      const raw=get('artwork/'+name),at=v.artOffset+offset;if(raw.length!==size||at+size>app.length)throw Error('图层尺寸或布局错误');app.set(raw,at);
    }
    await step('打包音乐与录音空间');
    const tracks=[];
    for(let i=0;i<items.length;i++){
      const item=items[i];if(item.path!==`audio/${String(i+1).padStart(3,'0')}.ogg`||!Number.isFinite(item.duration)||item.duration<=0||item.duration>900)throw Error('音频排序或时长错误');
      const packets=opusPackets(get(item.path)),count=Math.ceil(item.duration*50);if(packets.length<count)throw Error('音频数据不足');tracks.push(packets.slice(0,count));
      if(i%8===0)await step(`打包音乐 ${i+1} / ${items.length}`);
    }
    const record=recordImage(tracks,kind==='mixed'?3000000:0x500000);
    await step('计算镜像校验');await sealApp(app);
    const full=new Uint8Array(0x800000).fill(255);full.set(prefix);full.set(app,0x10000);full.set(record,0x300000);
    const hash=hex(await sha(full));await step('固件已生成，准备下载');
    return {blob:new Blob([full],{type:'application/octet-stream'}),hash};
  }
  globalThis.FolomanPacker={build,opusPackets,recordImage,sealApp};
})();