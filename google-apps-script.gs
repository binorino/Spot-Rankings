// IGTTYBTAP Google Sheets write endpoint
// Paste this into Extensions > Apps Script from the SPOT RANKINGS spreadsheet.
// Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone.
// Copy the /exec URL into RATING_WRITE_ENDPOINT in new-rating.js.

const SPREADSHEET_ID='10p5umfZPhTH7yOm5JSgua-VziUSwskiqjjKtEwZxlbA';
const CONFIG={
 'On Campus':{meta:{place:1,average:2,power:3,hours:4},notes:{Ashlyn:5,Marc:6,Lena:7},start:8,metrics:['Seating','Noise','Comfortability','Bathroom','Cleanliness','Convenience']},
 'K-Town':{meta:{place:1,average:2,power:3,wifi:4,hours:5},notes:{Ashlyn:6,Marc:7,Lena:8},start:9,metrics:['Seating','Affordability','Price','Distance','Drinks Yumminess','Food Yumminess','Noise','Comfortability','Area','Bathroom']},
 'Fryft Zone':{meta:{place:1,average:2,power:3,wifi:4,hours:5},notes:{Ashlyn:7,Marc:8,Lena:9},start:10,metrics:['Seating','Affordability','Price','Distance','Drinks Yumminess','Food Yumminess','Noise','Comfortability','Area','Bathroom']}
};
const PERSON_OFFSET={Lena:0,Ashlyn:1,Marc:2};
function json_(obj){return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON)}
function doGet(){return json_({ok:true,service:'IGTTYBTAP ratings endpoint'})}
function doPost(e){const lock=LockService.getScriptLock();try{lock.waitLock(10000);const p=JSON.parse(e.postData.contents||'{}'),cfg=CONFIG[p.category];if(!cfg)throw new Error('Invalid category');if(!(p.person in PERSON_OFFSET))throw new Error('Invalid rater');if(!p.place)throw new Error('Place is required');const ss=SpreadsheetApp.openById(SPREADSHEET_ID),sheet=ss.getSheetByName(p.category);if(!sheet)throw new Error('Sheet not found');const last=Math.max(sheet.getLastRow(),1),places=last>1?sheet.getRange(2,1,last-1,1).getDisplayValues().flat():[],needle=String(p.place).trim().toLowerCase();let row=places.findIndex(x=>String(x).trim().toLowerCase()===needle);row=row<0?-1:row+2;
 if(p.mode==='existing'){if(row<0)throw new Error('That place is not in this category');}
 else {if(row>0)throw new Error('That place already exists. Choose Current place instead.');row=last+1;sheet.getRange(row,cfg.meta.place).setValue(p.place);sheet.getRange(row,cfg.meta.power).setValue(p.power||'N/A');if(cfg.meta.wifi)sheet.getRange(row,cfg.meta.wifi).setValue(p.wifi||'N/A');sheet.getRange(row,cfg.meta.hours).setValue(p.hours||'N/A');for(let j=0;j<cfg.metrics.length;j++)for(let off=0;off<3;off++)sheet.getRange(row,cfg.start+j*3+off).setValue('N/A');}
 sheet.getRange(row,cfg.notes[p.person]).setValue(p.notes||'');const off=PERSON_OFFSET[p.person];cfg.metrics.forEach((metric,j)=>{let value=p.scores&&p.scores[metric]!=null?p.scores[metric]:'N/A';if(value!==''&&String(value).toUpperCase()!=='N/A'){value=Number(value);if(!Number.isFinite(value)||value<0||value>10)throw new Error('Invalid '+metric+' rating')}else value='N/A';sheet.getRange(row,cfg.start+j*3+off).setValue(value)});
 // Overall is the mean of all numeric individual category ratings on the row.
 const ratingWidth=cfg.metrics.length*3,values=sheet.getRange(row,cfg.start,1,ratingWidth).getValues()[0].filter(v=>typeof v==='number'&&isFinite(v));sheet.getRange(row,cfg.meta.average).setValue(values.length?values.reduce((a,b)=>a+b,0)/values.length:'N/A');SpreadsheetApp.flush();return json_({ok:true,row,place:p.place,category:p.category,person:p.person});
 }catch(err){return json_({ok:false,error:String(err.message||err)})}finally{try{lock.releaseLock()}catch(_){}}}