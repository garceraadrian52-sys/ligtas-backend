const {test}=require('node:test');const assert=require('node:assert/strict');
const {buildAnalyticsOverview,evacuationAnalytics}=require('../dist/services/analyticsOverview');
const barangays=[{id:'w',name:'Wawa'},{id:'s',name:'Santol'}];const now=Date.parse('2026-11-08T00:00:00Z');
test('new summary counts flood reports only, separates current statuses and confirmed affected barangays',()=>{
 const rows=[{type:'flood',barangayId:'w',status:'Verified',createdAt:'2026-11-01T00:00Z',verifiedAt:'2026-11-01T00:45Z'},{type:'flood',barangayId:'s',status:'Pending'},{type:'flood',barangayId:'s',status:'Rejected',verification:'Verified'},{type:'flood',status:'Resolved'},{type:'road',roadName:'Saved road',barangayId:'w',status:'Verified'}];const result=buildAnalyticsOverview(rows,[],[],barangays,'Balagtas',{now});assert.equal(result.total,4);assert.equal(result.metrics[1][2],'1');assert.equal(result.affectedBarangays,1);assert.equal(result.roads[0][0],'Saved road');assert.equal(result.verificationTotal,'45m');assert.equal(result.statusLegend.reduce((sum,row)=>sum+row.count,0),4);assert.equal(result.metrics.length,4);
});
test('current check-ins deduplicate household members and exclude checked-out records',()=>{
 const result=evacuationAnalytics([],[{id:'a',householdId:'h',barangayId:'w',memberIds:['1','2']},{id:'b',householdId:'h',barangayId:'w',memberIds:['2','3']},{id:'c',householdId:'other',barangayId:'s',memberIds:['1']},{id:'d',householdId:'old',status:'checked_out',memberIds:['x']}],barangays);assert.equal(result.totalEvacuees,4);assert.equal(result.byBarangay[0].count,3);assert.equal(result.byBarangay[1].count,1);
});
test('center utilization preserves zero, over-capacity and unknown readings',()=>{
 const result=evacuationAnalytics([{id:'a',name:'Zero',occupied:0,capacity:10},{id:'b',name:'Over',currentOccupancy:12,capacity:10},{id:'c',name:'No capacity',occupied:3},{id:'d',name:'No occupants',capacity:5}],[],barangays);const find=name=>result.utilization.find(row=>row.name===name);assert.equal(find('Zero').percentage,0);assert.equal(find('Over').percentage,120);assert.equal(result.utilizationMaximum,120);assert.equal(find('No capacity').percentage,null);assert.equal(find('No occupants').percentage,null);
});
test('failed and incomplete evacuation data never becomes a false zero total',()=>{
 assert.equal(evacuationAnalytics(null,null,barangays).totalEvacuees,null);assert.equal(evacuationAnalytics([],[],barangays).totalEvacuees,0);assert.equal(evacuationAnalytics([],[{id:'unknown'}],barangays).totalEvacuees,null);assert.equal(evacuationAnalytics(null,[{id:'h',memberIds:['a']}],barangays).totalEvacuees,1);
});
test('report month boundaries remain Manila-based while evacuation charts are current',()=>{
 const result=buildAnalyticsOverview([{type:'flood',status:'Verified',barangayId:'w',createdAt:'2026-10-31T16:00:00Z'},{type:'flood',createdAt:'2026-10-31T15:59:59Z'}],[],[{id:'h',memberIds:['a'],barangayId:'w'}],barangays,'Balagtas',{month:'2026-11',now});assert.equal(result.total,1);assert.equal(result.evacuation.totalEvacuees,1);assert.equal(result.metrics[1][2],'1');
});
