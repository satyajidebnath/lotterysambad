export function firstPrize(images){
 const text=images.map(image=>image.text||'').join(' ');
 const match=text.match(/\b(\d{2}[A-Z])\s*(\d{5})\b/);
 return match?{series:match[1],number:match[2]}:null;
}
