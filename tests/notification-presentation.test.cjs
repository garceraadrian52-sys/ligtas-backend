const {test}=require('node:test');
const assert=require('node:assert/strict');
const {pushPresentation,inArea,enabled}=require('../dist/services/notificationPolicy');
test('current Android installations use standard/urgent channels and matching delivery priority for both recipients',()=>{
 for(const role of ['RESIDENT','BARANGAY_OFFICIAL'])for(const kind of ['alert','evacuation'])for(const priority of ['Low','Moderate','Normal','High','Critical','unknown']) {
  const user={role,barangayId:'barangay_santol'},source={priority,coverageArea:'barangay',barangayId:'barangay_santol'};
  assert.equal(inArea(source,user),true);assert.equal(inArea(source,{...user,barangayId:'barangay_wawa'}),false);
  const payload=pushPresentation({kind,userId:role,targetId:'alert-id'},source,{platform:'android',notificationChannelVersion:1},'delivery-id');
  const urgent=['High','Critical'].includes(priority);
  assert.equal(payload.channelId,urgent?'ligtas-alerts-urgent-v1':'ligtas-alerts-standard-v1');
  assert.equal(payload.priority,urgent?'high':'normal');assert.equal(payload.sound,'default');
  assert.equal(payload.data.targetId,'alert-id');assert.equal(payload.data.userId,role);assert.equal(payload.data.alertPriority,priority.toLowerCase());
  assert.equal(payload.data.notificationId,'delivery-id');assert.equal(payload.tag,'ligtas:delivery-id');
 }
});
test('old registrations keep their existing channel, and unrelated push workflows retain their presentation',()=>{
 for(const device of [{platform:'android'},{platform:'ios',notificationChannelVersion:1}])assert.equal(pushPresentation({kind:'alert'},{priority:'Critical'},device,'id').channelId,'default');
 const payload=pushPresentation({kind:'report',targetId:'report-id',userId:'resident'},{priority:'High'},{platform:'android',notificationChannelVersion:1},'id');
 assert.equal(payload.channelId,'default');assert.equal(payload.priority,'default');assert.equal(payload.data.alertPriority,undefined);
 assert.equal(enabled({disabled:true},'alert'),false);assert.equal(enabled({notificationPreferences:{'Flood Alerts':false}},'alert'),false);
 assert.equal(pushPresentation({kind:'alert'},{severityLevel:' CRITICAL '},{platform:'android',notificationChannelVersion:1},'id').priority,'high');
});
