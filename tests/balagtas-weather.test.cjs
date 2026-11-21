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
test('missing or stale timestamps and empty responses never fall back to old sample readings',()=>{
  for(const modify of [p=>p.current.time-=3*3600,p=>p.current.time+=3600,p=>p.current.time=null,p=>{p.current={time:now/1000};delete p.hourly;}]){
    const p=payload();modify(p);assert.throws(()=>normalizeWeather(p,now));
  }
  const missingRain=payload();missingRain.hourly.rain[5]=null;assert.equal(normalizeWeather(missingRain,now).rain24hMm,null);
});
test('missing visibility or humidity does not discard available temperature, condition, wind and rainfall',()=>{
  const p=payload();delete p.current.visibility;delete p.current_units.visibility;p.current.relative_humidity_2m=null;
  const value=normalizeWeather(p,now);
  assert.equal(value.visibilityKm,null);assert.equal(value.humidity,null);assert.equal(value.temperatureC,28.4);
  assert.equal(value.condition,'Partly cloudy');assert.equal(value.windKmh,0);assert.equal(value.rain24hMm,18);
});
test('each unavailable or invalid metric remains null without coercing values or changing other readings',()=>{
  for(const [field,key,invalid] of [['temperature_2m','temperatureC',null],['temperature_2m','temperatureC','28'],['relative_humidity_2m','humidity',101],['wind_speed_10m','windKmh',-1],['visibility','visibilityKm',null]]){
    const p=payload();p.current[field]=invalid;const value=normalizeWeather(p,now);assert.equal(value[key],null);assert.equal(value.condition,'Partly cloudy');
  }
  const p=payload();p.current_units.temperature_2m='°F';p.current_units.wind_speed_10m='m/s';p.current_units.visibility='km';
  const value=normalizeWeather(p,now);assert.equal(value.temperatureC,null);assert.equal(value.windKmh,null);assert.equal(value.visibilityKm,null);assert.equal(value.humidity,77);
  for(const weather_code of [null,2.5,'2',Infinity,100]){
    const value=normalizeWeather({...payload(),current:{...payload().current,weather_code}},now);
    assert.equal(value.weatherCode,null);assert.equal(value.condition,'Condition unavailable');assert.equal(value.temperatureC,28.4);
  }
});
test('rainfall requires a complete contiguous 24-hour window and preserves zero rainfall and zero visibility',()=>{
  const p=payload();p.current.visibility=0;p.hourly.rain.fill(0);p.hourly.showers.fill(0);
  const value=normalizeWeather(p,now);assert.equal(value.visibilityKm,0);assert.equal(value.rain24hMm,0);
  for(const modify of [p=>delete p.hourly,p=>delete p.hourly.showers,p=>p.hourly.rain[5]=null,p=>p.hourly.time[5]=p.hourly.time[4],p=>p.hourly_units.rain='inch']){
    const p=payload();modify(p);const value=normalizeWeather(p,now);assert.equal(value.rain24hMm,null);assert.equal(value.temperatureC,28.4);
  }
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
test('partial responses are cached, survive an outage with their date, and recover after the retry delay',async()=>{
  let clock=now,calls=0,fail=false;const p=payload();delete p.current.visibility;delete p.current_units.visibility;
  const service=createBalagtasWeatherService(async()=>{calls++;return fail?{ok:false,status:429}:{ok:true,json:async()=>({...p,current:{...p.current,time:clock/1000}})};},()=>clock);
  const first=await service.get();assert.equal(first.temperatureC,28.4);assert.equal(first.visibilityKm,null);
  clock+=11*60000;fail=true;
  const stale=await service.get();assert.equal(stale.status,'stale');assert.equal(stale.observedAt,first.observedAt);assert.equal(stale.humidity,77);
  await service.get();assert.equal(calls,2);
  fail=false;clock+=60000;const fresh=await service.get();assert.equal(fresh.status,'available');assert.notEqual(fresh.observedAt,first.observedAt);assert.equal(calls,3);
});
test('API HTTP, JSON, timeout and empty-data failures remain unavailable and produce sanitized diagnostics',async()=>{
  const original=console.warn,logs=[];console.warn=(...args)=>logs.push(args);
  try{
    for(const fetcher of [async()=>({ok:false,status:503}),async()=>({ok:true,json:async()=>{throw new SyntaxError('private response body');}}),async()=>{throw Object.assign(new Error('private URL or headers'),{name:'TimeoutError'});},async()=>({ok:true,json:async()=>({})})]){
      assert.equal(await createBalagtasWeatherService(fetcher,()=>now).get(),null);
    }
  }finally{console.warn=original;}
  assert.equal(logs.length,4);assert.deepEqual(logs[0][1],{reason:'upstream-http',status:503});assert.equal(logs[2][1].reason,'timeout');
  assert.doesNotMatch(JSON.stringify(logs),/private|headers/);
});

const limited = retryAfter => ({ok:false,status:429,headers:new Headers(retryAfter===undefined?{}:{'Retry-After':retryAfter})});
test('429 backoff grows exponentially to one hour and coalesces callers at every retry boundary',async t=>{
  const logs=[];t.mock.method(console,'warn',(...args)=>logs.push(args));
  let clock=now,calls=0;
  const service=createBalagtasWeatherService(async()=>{calls++;return limited();},()=>clock);
  for(const minutes of [1,2,4,8,16,32,60,60]){
    const previousCalls=calls;
    assert.ok((await Promise.all(Array.from({length:30},()=>service.get()))).every(value=>value===null));
    assert.equal(calls,previousCalls+1);
    clock+=minutes*60000-1;
    assert.equal(await service.get(),null);
    assert.equal(calls,previousCalls+1,'callers must not retry before the backoff deadline');
    clock++;
  }
  assert.deepEqual(logs.map(log=>log[1].retryInSeconds),[60,120,240,480,960,1920,3600,3600]);
  assert.ok(logs.every(log=>log[0]==='Balagtas weather refresh failed.'&&log[1].reason==='upstream-http'&&log[1].status===429));
});

test('429 respects Retry-After seconds and HTTP dates, including a server delay longer than the backoff cap',async t=>{
  t.mock.method(console,'warn',()=>{});
  for(const [header,delay] of [['900',900000],[new Date(now+20*60000).toUTCString(),20*60000],['7200',7200000]]){
    let clock=now,calls=0;
    const service=createBalagtasWeatherService(async()=>{calls++;return limited(header);},()=>clock);
    assert.equal(await service.get(),null);
    clock+=delay-1;
    await Promise.all(Array.from({length:20},()=>service.get()));assert.equal(calls,1,header);
    clock++;
    await Promise.all([service.get(),service.get()]);assert.equal(calls,2,header);
  }
});

test('short, missing, invalid or past Retry-After values cannot shorten the exponential backoff',async t=>{
  t.mock.method(console,'warn',()=>{});
  for(const header of [undefined,'','0','1','-10','1.5','not-a-date','9'.repeat(400),new Date(now-60000).toUTCString()]){
    let clock=now,calls=0;
    const service=createBalagtasWeatherService(async()=>{calls++;return limited(header);},()=>clock);
    await service.get();clock+=59999;await service.get();assert.equal(calls,1);
    clock++;await service.get();assert.equal(calls,2);
    clock+=119999;await service.get();assert.equal(calls,2,`${header}: second limit must wait two minutes`);
    clock++;await service.get();assert.equal(calls,3);
  }
});

test('rate limiting retains real cached readings and their timestamps, but never extends the observation safety window',async t=>{
  t.mock.method(console,'warn',()=>{});
  let clock=now,calls=0,rateLimited=false;
  const service=createBalagtasWeatherService(async()=>{calls++;return rateLimited?limited('10800'):{ok:true,json:async()=>payload()};},()=>clock);
  const first=await service.get();
  clock+=11*60000;rateLimited=true;
  const stale=await service.get();assert.equal(stale.status,'stale');
  for(const field of ['observedAt','retrievedAt','temperatureC','humidity','windKmh','visibilityKm','rain24hMm','condition','weatherCode']) assert.equal(stale[field],first[field],field);
  assert.match(stale.error,/dated cached estimate/);
  clock+=20*60000;
  assert.equal((await service.get()).observedAt,first.observedAt);assert.equal(calls,2);
  clock=now+2*3600000+1;
  assert.equal(await service.get(),null);assert.equal(calls,2,'expired cache must not bypass the provider cooldown');
});

test('only a valid successful reading resets rate-limit backoff and restores the normal cache',async t=>{
  const logs=[];t.mock.method(console,'warn',(...args)=>logs.push(args));
  let clock=now,calls=0,mode='limited';
  const service=createBalagtasWeatherService(async()=>{
    calls++;
    return mode==='limited'?limited():{ok:true,json:async()=>mode==='invalid'?{}:{...payload(),current:{...payload().current,time:clock/1000}}};
  },()=>clock);
  assert.equal(await service.get(),null);clock+=60000;
  mode='invalid';assert.equal(await service.get(),null);clock+=60000;
  mode='limited';assert.equal(await service.get(),null);
  assert.equal(logs.at(-1)[1].retryInSeconds,120);
  clock+=120000;mode='valid';const recovered=await service.get();assert.equal(recovered.status,'available');
  const successCalls=calls;await service.get();assert.equal(calls,successCalls);
  clock+=10*60000;mode='limited';const stale=await service.get();assert.equal(stale.status,'stale');
  assert.equal(logs.at(-1)[1].retryInSeconds,60);
  clock+=60000;mode='valid';assert.equal((await service.get()).status,'available');
});
