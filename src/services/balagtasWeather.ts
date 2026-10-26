import { BALAGTAS_LOCATION, isInBalagtas } from './balagtasMonitoring';
type WeatherData = ReturnType<typeof normalizeWeather>;
const numeric = (value: unknown, min: number, max: number): number | null => typeof value==='number' && Number.isFinite(value) && value>=min && value<=max ? value : null;
const descriptions:Record<number,[string,string]> = {0:['Clear sky','☀️'],1:['Mainly clear','🌤️'],2:['Partly cloudy','⛅'],3:['Overcast','☁️'],45:['Fog','🌫️'],48:['Freezing fog','🌫️'],51:['Light drizzle','🌦️'],53:['Drizzle','🌦️'],55:['Heavy drizzle','🌧️'],56:['Freezing drizzle','🌧️'],57:['Heavy freezing drizzle','🌧️'],61:['Light rain','🌦️'],63:['Rain','🌧️'],65:['Heavy rain','🌧️'],66:['Freezing rain','🌧️'],67:['Heavy freezing rain','🌧️'],71:['Light snow','🌨️'],73:['Snow','🌨️'],75:['Heavy snow','🌨️'],77:['Snow grains','🌨️'],80:['Light rain showers','🌦️'],81:['Rain showers','🌧️'],82:['Violent rain showers','🌧️'],85:['Snow showers','🌨️'],86:['Heavy snow showers','🌨️'],95:['Thunderstorm','⛈️'],96:['Thunderstorm with hail','⛈️'],99:['Severe thunderstorm with hail','⛈️']};

export function weatherUrl(): string {
  if (!isInBalagtas(BALAGTAS_LOCATION)) throw new Error('Weather target must be inside Balagtas.');
  const url=new URL('https://api.open-meteo.com/v1/forecast');
  url.search=new URLSearchParams({ latitude:String(BALAGTAS_LOCATION.latitude),longitude:String(BALAGTAS_LOCATION.longitude),
    current:'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,visibility',hourly:'rain,showers',past_hours:'24',forecast_hours:'1',
    timezone:'Asia/Manila',timeformat:'unixtime',temperature_unit:'celsius',wind_speed_unit:'kmh',precipitation_unit:'mm' }).toString();
  return url.toString();
}

export function normalizeWeather(payload: any, now = Date.now()) {
  const current=payload?.current;
  const observed=numeric(current?.time,0,8640000000000);
  if (observed===null || observed*1000>now+15*60000 || now-observed*1000>2*3600000) throw new Error('Weather response is missing a recent timestamp.');
  const units=payload.current_units;
  if (units?.temperature_2m!=='°C' || units?.wind_speed_10m!=='km/h' || units?.relative_humidity_2m!=='%' || units?.visibility!=='m') throw new Error('Unexpected weather units.');
  const temperatureC=numeric(current.temperature_2m,-60,65),humidity=numeric(current.relative_humidity_2m,0,100),windKmh=numeric(current.wind_speed_10m,0,500),visibilityM=numeric(current.visibility,0,500000);
  if (temperatureC===null || humidity===null || windKmh===null) throw new Error('Weather response is incomplete.');
  const times=payload.hourly?.time;
  const rain=payload.hourly?.rain,showers=payload.hourly?.showers;
  const indices=Array.isArray(times)?times.flatMap((time:unknown,index:number)=>typeof time==='number'&&time>observed-86400&&time<=observed?[index]:[]):[];
  const validRain=indices.length===24 && payload.hourly_units?.rain==='mm' && payload.hourly_units?.showers==='mm' && indices.every((index:number)=>numeric(rain?.[index],0,3000)!==null&&numeric(showers?.[index],0,3000)!==null);
  const rain24hMm=validRain?Math.round(indices.reduce((sum:number,index:number)=>sum+rain[index]+showers[index],0)*10)/10:null;
  const [condition,icon]=descriptions[current.weather_code] || ['Condition unavailable','☁️'];
  return {status:'available' as 'available'|'stale',location:BALAGTAS_LOCATION,source:{name:'Open-Meteo',url:'https://open-meteo.com/',kind:'Weather model estimate'},
    observedAt:new Date(observed*1000).toISOString(),retrievedAt:new Date(now).toISOString(),temperatureC,humidity,windKmh,visibilityKm:visibilityM===null?null:Math.round(visibilityM/100)/10,
    rain24hMm,condition,icon,grid:{latitude:payload.latitude??null,longitude:payload.longitude??null},
    note:'Model estimates for the fixed Balagtas location; not a local weather-station measurement.',error:null as string|null};
}

export function createBalagtasWeatherService(fetcher: typeof fetch = fetch, clock:()=>number=Date.now) {
  let cached:WeatherData|null=null;
  let retryAfter=0;
  let inFlight:Promise<WeatherData|null>|null=null;
  const fallback=()=>cached&&clock()-Date.parse(cached.observedAt)<=2*3600000 ? {...cached,status:'stale' as const,error:'Weather refresh unavailable; showing the dated cached estimate.'} : null;
  async function refresh() {
    try {
      const response=await fetcher(weatherUrl(),{signal:AbortSignal.timeout(8000),headers:{Accept:'application/json'}});
      if (!response.ok) throw new Error('Weather service unavailable.');
      cached=normalizeWeather(await response.json(),clock());retryAfter=0;return cached;
    } catch {retryAfter=clock()+60000;return fallback();}
    finally {inFlight=null;}
  }
  return {async get() {
    if (cached&&clock()-Date.parse(cached.retrievedAt)<10*60000&&clock()-Date.parse(cached.observedAt)<2*3600000) return cached;
    if (inFlight) return inFlight;
    if (clock()<retryAfter) return fallback();
    inFlight=Promise.resolve().then(refresh);return inFlight;
  }};
}
export const balagtasWeather=createBalagtasWeatherService();
