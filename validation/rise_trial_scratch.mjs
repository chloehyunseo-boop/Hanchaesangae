// 시험 계산(엔진 아님): ISC3 2권 식 1-1·1-8·1-12~1-22·1-50(zr=0, 혼합고 무시)
import { stabilityFromForecast, noxEmissionFactorGPerKWh } from "../engine/plume.js";
const g=9.81;
const SIG={C:{y:x=>0.22*x*(1+0.0004*x)**-0.5,z:x=>0.20*x,p:0.20},D:{y:x=>0.16*x*(1+0.0004*x)**-0.5,z:x=>0.14*x*(1+0.0003*x)**-0.5,p:0.25},E:{y:x=>0.11*x*(1+0.0004*x)**-0.5,z:x=>0.08*x*(1+0.0015*x)**-0.5,p:0.30},F:{y:x=>0.11*x*(1+0.0004*x)**-0.5,z:x=>0.08*x*(1+0.0015*x)**-0.5,p:0.30}};
function rise(st,us,Fb,Ta,x,instant){ // 부력 지배 가정, 점진 상승(1-22)과 최종 상승 중 작은 값
  let final;
  if(st==="E"||st==="F"){const s=g*(st==="E"?0.020:0.035)/Ta; final=2.6*Math.cbrt(Fb/(us*s));}
  else final = Fb<55 ? 21.425*Fb**0.75/us : 38.71*Fb**0.6/us;
  if(instant) return final; const grad=1.60*Math.cbrt(Fb)*x**(2/3)/us; return Math.min(grad,final);
}
const arm2=(ug)=>{const y=-1.1723E-17*ug**6+4.2795E-14*ug**5-5.8345E-11*ug**4+3.4555E-08*ug**3-5.6062E-06*ug**2-2.7383E-03*ug+1.2441E+00;return Math.min(0.9,Math.max(0.5,y));};
function conc({st,u10,x,n=5,kw=500,load=1,no2=0.9,hs=0,Fb=0,Ta=283,instant=false}){
  const Q=kw*noxEmissionFactorGPerKWh(kw)/3600*load*n; // NOx g/s
  const href = hs>0?hs:2; const us=Math.max(u10*(href/10)**SIG[st].p,1);
  const he = hs + (Fb>0?rise(st,us,Fb,Ta,x,instant):0);
  const nox=Q/(Math.PI*us*SIG[st].y(x)*SIG[st].z(x))*Math.exp(-0.5*(he/SIG[st].z(x))**2); // g/m3
  const r = no2==="ARM2" ? arm2(nox*1e6) : no2;
  return {ppm:nox*r*1000*24.45/46.0055, he, r};
}
const reach=(o,th)=>{let last=0;for(let x=50;x<=5000;x+=25){if(conc({...o,x}).ppm>=th)last=x;}return last>=5000?">5km":(last/1000).toFixed(2)+"km";};
// 배기: CAT XQ570 prime 정격 472°C, 86.7 m3/min (스펙시트)
const Ts=472+273.15, V=86.7/60, Ta=283.15, Fb=g*V*(Ts-Ta)/(Math.PI*Ts);
console.log("Fb =",Fb.toFixed(2),"m4/s3");
const D={lat:37.519163,lon:127.127359}, t=new Date("2026-11-21T19:00:00+09:00");
const SC={
 "지금(최악)":{},
 "①부하율 0.43":{load:0.43},
 "①+②ARM2":{load:0.43,no2:"ARM2"},
 "①+②+③연기상승(배기구3m)":{load:0.43,no2:"ARM2",hs:3,Fb,Ta},
 "①+②+③(부력 절반)":{load:0.43,no2:"ARM2",hs:3,Fb:Fb/2,Ta},
 "①+②+③(부력 1/4)":{load:0.43,no2:"ARM2",hs:3,Fb:Fb/4,Ta},
 "①+②+배기구3m, 상승없음":{load:0.43,no2:"ARM2",hs:3,Fb:0,Ta},
 "①+②+③ 최종상승 즉시":{load:0.43,no2:"ARM2",hs:3,Fb,Ta,instant:true},
};
for (const [sky,u10] of [["맑음",2],["맑음",4],["흐림",4],["맑음",6]]){
 const st=stabilityFromForecast({sky,wsd10m:u10,lat:D.lat,lon:D.lon,dateUtc:t}).stability;
 console.log(`\n## ${sky} ${u10}m/s (${st})`);
 for (const [k,o] of Object.entries(SC)){const a={st,u10,...o};
  console.log(k.padEnd(22),"300m",conc({...a,x:300}).ppm.toFixed(3)+`(r${conc({...a,x:300}).r})`,"1km",conc({...a,x:1000}).ppm.toFixed(3),"| 강까지",reach(a,0.05),"중까지",reach(a,0.01), o.hs?`| 연기높이@1km ${conc({...a,x:1000}).he.toFixed(0)}m`:"");}
}
