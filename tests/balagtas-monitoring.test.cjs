const {test}=require('node:test');
const assert=require('node:assert/strict');
const {BALAGTAS_LOCATION,isInBalagtas,buildBalagtasWaterTrend}=require('../dist/services/balagtasMonitoring');
const now=Date.parse('2026-10-26T00:00:00Z');
const inside={latitude:14.817733,longitude:120.895297};
const report=(extra={})=>({status:'Verified',type:'flood',waterLevel:'Knee Deep',createdAt:new Date(now-30*60000).toISOString(),...inside,...extra});
test('municipal polygon accepts the actual submitted point and rejects nearby municipalities and bounding-box corners',()=>{
  assert.equal(isInBalagtas(BALAGTAS_LOCATION),true);assert.equal(isInBalagtas(inside),true);
  for(const point of [{latitude:14.76,longitude:120.96},{latitude:14.6,longitude:120.98},{latitude:NaN,longitude:120.9}])assert.equal(isInBalagtas(point),false);
});
test('24-hour trend excludes unverified, outside, undated and stale observations instead of fabricating zeroes',()=>{
  const trend=buildBalagtasWaterTrend([
    report(),report({status:'Pending',verification:'Verified'}),report({status:'Rejected'}),
    report({latitude:14.76,longitude:120.96}),report({latitude:null}),report({createdAt:null}),
    report({createdAt:new Date(now-25*3600000).toISOString()}),report({createdAt:new Date(now+60000).toISOString()}),
    report({waterLevel:'not measured'}),
  ],now);
  assert.equal(trend.defaultSeries,'flood');assert.equal(trend.count,1);
  assert.equal(trend.bins[23].label,'Knee deep');assert.equal(trend.bins[22].level,null);
  assert.equal(trend.excluded.outside,1);assert.equal(trend.excluded.missingCoordinates,1);
  assert.equal(trend.chart.points.length,1);assert.equal(trend.chart.segments.length,1);
  assert.ok(!trend.chart.segments[0].includes('L'));
});
test('missing hours break the line; road categories preserve the real input labels separately from body-depth reports',()=>{
  const trend=buildBalagtasWaterTrend([
    report({createdAt:new Date(now-3.5*3600000).toISOString(),waterLevel:'Ankle Deep'}),
    report({createdAt:new Date(now-2.5*3600000).toISOString(),waterLevel:'Waist Deep'}),report(),
    report({type:'road',waterLevel:null,floodingLevel:'Knee Level'}),
    report({type:'road',waterLevel:null,floodingLevel:'None',createdAt:new Date(now-1.5*3600000).toISOString()}),
  ],now);
  assert.equal(trend.count,3);assert.equal(trend.chart.segments.length,2);
  const road=trend.series.find(item=>item.id==='road');assert.equal(road.count,2);
  assert.equal(road.bins[23].label,'Knee Level');assert.equal(road.bins[22].label,'None');
  assert.equal(trend.bins[23].label,'Knee deep');
});
test('road-only observations select their own series, and empty hours remain null',()=>{
  const trend=buildBalagtasWaterTrend([report({waterLevel:null,type:'road',floodingLevel:'Above Knee Level'})],now);
  assert.equal(trend.defaultSeries,'road');assert.equal(trend.bins[23].label,'Above Knee Level');
  const empty=buildBalagtasWaterTrend([],now);assert.equal(empty.count,0);assert.ok(empty.bins.every(bin=>bin.level===null));
});
