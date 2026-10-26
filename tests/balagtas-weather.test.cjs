const {test}=require('node:test');
const assert=require('node:assert/strict');
const {weatherUrl,normalizeWeather,createBalagtasWeatherService}=require('../dist/services/balagtasWeather');
const {BALAGTAS_LOCATION,isInBalagtas}=require('../dist/services/balagtasMonitoring');
const now=Date.parse('2026-10-26T00:00:00Z');
function payload(){
  return {latitude:14.797891,longitude:120.92179,current:{time:now/1000,temperature_2m:28.4,relative_humidity_2m:77,wind_speed_10m:0,weather_code:2,visibility:34000},
    current_units:{temperature_2m:'°C',relative_humidity_2m:'%',wind_speed_10m:'km/h',visibility:'m'},
    hourly:{time:Array.from({length:25},(_,i)=>now/1000+(i-24)*3600),rain:Array(25).fill(.5),showers:Array(25).fill(.25)},hourly_units:{rain:'mm',showers:'mm'}};
}
test('weather request is pinned to the existing point inside Balagtas, with explicit units and Manila timezone',()=>{
  const url=new URL(weatherUrl());assert.equal(url.origin,'https://api.open-meteo.com');
  assert.equal(Number(url.searchParams.get('latitude')),BALAGTAS_LOCATION.latitude);assert.equal(Number(url.searchParams.get('longitude')),BALAGTAS_LOCATION.longitude);
  assert.equal(isInBalagtas(BALAGTAS_LOCATION),true);assert.equal(url.searchParams.get('timezone'),'Asia/Manila');
  assert.equal(url.searchParams.get('timeformat'),'unixtime');
});
test('weather values and trailing 24-hour rain preserve real zeroes and distinguish model grids from the request point',()=>{
  const value=normalizeWeather(payload(),now);
  assert.equal(value.temperatureC,28.4);assert.equal(value.humidity,77);assert.equal(value.windKmh,0);
  assert.equal(value.visibilityKm,34);assert.equal(value.rain24hMm,18);assert.equal(value.condition,'Partly cloudy');
  assert.equal(value.location.name,'Balagtas, Bulacan');assert.equal(value.source.kind,'Weather model estimate');
  assert.notEqual(value.grid.latitude,value.location.latitude);
});
test('missing, stale or inconsistent weather never falls back to the old sample readings',()=>{
  for(const modify of [p=>p.current.time-=3*3600,p=>p.current.temperature_2m=null,p=>p.current_units.temperature_2m='fahrenheit',p=>p.current.relative_humidity_2m=101]){
    const p=payload();modify(p);assert.throws(()=>normalizeWeather(p,now));
  }
  const missingRain=payload();missingRain.hourly.rain[5]=null;assert.equal(normalizeWeather(missingRain,now).rain24hMm,null);
});
test('concurrent callers share one request; caches refresh, label outages and expire old estimates',async()=>{
  let clock=now,calls=0,fail=false;
  const service=createBalagtasWeatherService(async()=>{calls++;if(fail)throw new Error('offline');return {ok:true,json:async()=>payload()};},()=>clock);
  const [a,b]=await Promise.all([service.get(),service.get()]);assert.equal(calls,1);assert.equal(a,b);
  await service.get();assert.equal(calls,1);
  clock+=11*60000;fail=true;
  const stale=await service.get();assert.equal(calls,2);assert.equal(stale.status,'stale');
  await service.get();assert.equal(calls,2);
  clock=now+3*3600000;assert.equal(await service.get(),null);
});
