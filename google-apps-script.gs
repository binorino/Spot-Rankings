// IGTTYBTAP Google Sheets + reliable separate photo upload endpoint
// After copying into Apps Script: Deploy > Manage deployments > Edit > New version > Deploy.
const SPREADSHEET_ID='10p5umfZPhTH7yOm5JSgua-VziUSwskiqjjKtEwZxlbA';
// Area columns are read from each tab's header row — see areaConfig_() below.
const PERSON_OFFSET={Lena:0,Ashlyn:1,Marc:2};
function json_(o){return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON)}
function doGet(e){if(e&&e.parameter&&e.parameter.areas){const ss=SpreadsheetApp.openById(SPREADSHEET_ID);return json_({ok:true,areas:listAreas_(ss)})}return json_({ok:true,service:'IGTTYBTAP ratings + separate photo uploads endpoint',version:6})}
function photoSheet_(ss){let sh=ss.getSheetByName('Photos');if(!sh){sh=ss.insertSheet('Photos');sh.appendRow(['Place','Area','Photo Type','Image URL','Drive File ID','Submitted By','Timestamp'])}return sh}
function photoFolder_(){const name='IGTTYBTAP Spot Photos';const it=DriveApp.getFoldersByName(name),folder=it.hasNext()?it.next():DriveApp.createFolder(name);try{folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK,DriveApp.Permission.VIEW)}catch(e){}return folder}
function saveOnePhoto_(ss,p){const photo=p.photo;if(photo&&photo.url){if(!['cover','food','drinks'].includes(photo.type))throw new Error('Invalid photo type');if(!/^https:\/\/res\.cloudinary\.com\/k8af2qva\/image\/upload\//.test(String(photo.url)))throw new Error('Photo link must come from Cloudinary');photoSheet_(ss).appendRow([p.place,p.category,photo.type,photo.url,photo.publicId||'',p.person,new Date()]);SpreadsheetApp.flush();return{fileId:photo.publicId||'',url:photo.url}}if(!photo||!photo.data||!['cover','food','drinks'].includes(photo.type))throw new Error('Invalid photo payload');const m=String(photo.data).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);if(!m)throw new Error('Invalid image data');const bytes=Utilities.base64Decode(m[2]);if(bytes.length>8*1024*1024)throw new Error('Photo is too large');const safe=String(p.place).replace(/[^a-z0-9_-]+/gi,'-')||'spot',folder=photoFolder_(),blob=Utilities.newBlob(bytes,m[1],safe+'-'+photo.type+'-'+Date.now()+'.jpg'),file=folder.createFile(blob);try{file.setSharing(DriveApp.Access.ANYONE_WITH_LINK,DriveApp.Permission.VIEW)}catch(e){}const url='https://drive.google.com/thumbnail?id='+file.getId()+'&sz=w1600';photoSheet_(ss).appendRow([p.place,p.category,photo.type,url,file.getId(),p.person,new Date()]);SpreadsheetApp.flush();return{fileId:file.getId(),url}}
function saveRating_(ss,p){const cfg=areaConfigByName_(ss,p.category);if(!cfg)throw new Error('Invalid area');if(!(p.person in PERSON_OFFSET))throw new Error('Invalid rater');if(!p.place)throw new Error('Place is required');const sheet=ss.getSheetByName(p.category);if(!sheet)throw new Error('Sheet not found');const last=Math.max(sheet.getLastRow(),1),places=last>1?sheet.getRange(2,1,last-1,1).getDisplayValues().flat():[],needle=String(p.place).trim().toLowerCase();let row=places.findIndex(x=>String(x).trim().toLowerCase()===needle);row=row<0?-1:row+2;if(p.mode==='existing'){if(row<0)throw new Error('That place is not in this category');if(cfg.meta.wifi&&p.wifi&&String(p.wifi).toUpperCase()!=='N/A')sheet.getRange(row,cfg.meta.wifi).setValue(p.wifi)}else{if(row>0)throw new Error('That place already exists. Choose Current place instead.');row=last+1;sheet.getRange(row,cfg.meta.place).setValue(p.place);sheet.getRange(row,cfg.meta.power).setValue(p.power||'N/A');if(cfg.meta.wifi)sheet.getRange(row,cfg.meta.wifi).setValue(p.wifi||'N/A');sheet.getRange(row,cfg.meta.hours).setValue(p.hours||'N/A');for(let j=0;j<cfg.metrics.length;j++)for(let off=0;off<3;off++)sheet.getRange(row,cfg.start+j*3+off).setValue('N/A')}sheet.getRange(row,cfg.notes[p.person]).setValue(p.notes||'');const off=PERSON_OFFSET[p.person];cfg.metrics.forEach((metric,j)=>{let value=p.scores&&p.scores[metric]!=null?p.scores[metric]:'N/A';if(value!==''&&String(value).toUpperCase()!=='N/A'){value=Number(value);if(!Number.isFinite(value)||value<0||value>10)throw new Error('Invalid '+metric+' rating')}else value='N/A';sheet.getRange(row,cfg.start+j*3+off).setValue(value)});const values=sheet.getRange(row,cfg.start,1,cfg.metrics.length*3).getValues()[0].filter(v=>typeof v==='number'&&isFinite(v));sheet.getRange(row,cfg.meta.average).setValue(values.length?values.reduce((a,b)=>a+b,0)/values.length:'N/A');SpreadsheetApp.flush();return{row}}
function doPost(e){const lock=LockService.getScriptLock();try{lock.waitLock(20000);const p=JSON.parse((e.postData&&e.postData.contents)||'{}');if(!p.place)throw new Error('Place is required');if(!(p.person in PERSON_OFFSET))throw new Error('Invalid rater');const ss=SpreadsheetApp.openById(SPREADSHEET_ID);if(p.action!=='photo'&&p.newArea)createArea_(ss,p);if(!areaConfigByName_(ss,p.category))throw new Error('Invalid area');if(p.action==='photo'){const saved=saveOnePhoto_(ss,p);return json_({ok:true,action:'photo',place:p.place,type:p.photo.type,fileId:saved.fileId,url:saved.url})}const result=saveRating_(ss,p);return json_({ok:true,action:'rating',row:result.row,place:p.place,category:p.category,person:p.person})}catch(err){console.error(err);return json_({ok:false,error:String(err&&err.message||err)})}finally{try{lock.releaseLock()}catch(e){}}}

// ---------------------------------------------------------------------------
// Areas (version 6): any tab whose header row follows the rating layout is an
// area — Place · Average · [power] · [wifi] · [times] · <Name> Notes … · then one
// header per category, each over three columns (Lena, Ashlyn, Marc).
// Columns are read from the header, so new tabs work without code changes.
// ---------------------------------------------------------------------------
const NOT_AREAS_=['photos','sessions','rating log'];

function areaConfig_(sheet){
  if(!sheet||NOT_AREAS_.includes(sheet.getName().trim().toLowerCase()))return null;
  const lastCol=sheet.getLastColumn();
  if(lastCol<4)return null;
  const h=sheet.getRange(1,1,1,lastCol).getDisplayValues()[0].map(x=>String(x).trim());
  if(!/^place$/i.test(h[0]))return null;
  const find=re=>{const i=h.findIndex(x=>re.test(x));return i<0?null:i+1};
  const notes={};let lastNote=0;
  h.forEach((x,i)=>{const m=x.match(/^(.+?)\s+notes$/i);if(!m)return;const who=Object.keys(PERSON_OFFSET).find(p=>p.toLowerCase()===m[1].trim().toLowerCase());if(who){notes[who]=i+1;lastNote=Math.max(lastNote,i+1)}});
  const average=find(/^average/i);
  if(!average||Object.keys(notes).length!==Object.keys(PERSON_OFFSET).length)return null;
  const metrics=[];let start=null;
  for(let c=lastNote+1;c<=lastCol;c++){const name=h[c-1];if(!name)continue;if(start===null)start=c;if(c!==start+metrics.length*3)return null;metrics.push(name)}
  if(!metrics.length)return null;
  const meta={place:1,average:average,power:find(/power/i),hours:find(/^(times|hours)/i)};
  const wifi=find(/wi-?fi/i);if(wifi)meta.wifi=wifi;
  return {meta:meta,notes:notes,start:start,metrics:metrics};
}
const areaCache_={};
function areaConfigByName_(ss,name){
  const key=String(name||'');
  if(!(key in areaCache_))areaCache_[key]=key?areaConfig_(ss.getSheetByName(key)):null;
  return areaCache_[key];
}
function listAreas_(ss){
  return ss.getSheets().map(sh=>{const c=areaConfig_(sh);return c?{name:sh.getName(),metrics:c.metrics,hasWifi:!!c.meta.wifi}:null}).filter(Boolean);
}
// Create a new area tab with the same columns as an existing area (or set up an empty tab that already has that name)
function createArea_(ss,p){
  const name=String(p.category||'').trim().replace(/\s+/g,' ');
  if(!name||name.length>40)throw new Error('Give the new area a name (up to 40 characters)');
  if(NOT_AREAS_.includes(name.toLowerCase()))throw new Error('That name is used by another tab');
  const template=ss.getSheetByName(String(p.newArea.template||''));
  if(!areaConfig_(template))throw new Error('Pick an existing area to copy categories from');
  const existing=ss.getSheets().find(sh=>sh.getName().trim().toLowerCase()===name.toLowerCase());
  let sh=existing;
  if(existing){
    if(areaConfig_(existing)){p.category=existing.getName();return}            // already set up — just use it
    if(existing.getLastRow()>1||existing.getRange(1,1).getDisplayValue()!=='')throw new Error('A tab named "'+existing.getName()+'" already exists but its columns don’t match the other areas — rename it, or copy the header row from another area');
  }else{
    sh=ss.insertSheet(name,ss.getSheets().length);
  }
  const width=template.getLastColumn();
  template.getRange(1,1,1,width).copyTo(sh.getRange(1,1,1,width));
  sh.setFrozenRows(template.getFrozenRows());
  SpreadsheetApp.flush();
  p.category=sh.getName();
  delete areaCache_[p.category];
  p.mode='new';
}

