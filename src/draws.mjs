export const DRAWS=[
 {id:'MN',label:'Morning',drawTime:'13:00',downloadTime:'13:10'},
 {id:'DN',label:'Evening',drawTime:'18:00',downloadTime:'18:10'},
 {id:'EN',label:'Night',drawTime:'20:00',downloadTime:'20:10'}
];
export function indiaDateParts(date=new Date()){
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
 const get=type=>parts.find(part=>part.type===type).value;
 return {date:`${get('year')}-${get('month')}-${get('day')}`,stamp:`${get('day')}${get('month')}${get('year').slice(-2)}`,time:`${get('hour')}:${get('minute')}`};
}
