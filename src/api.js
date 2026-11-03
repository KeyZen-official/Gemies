let csrf='';
export const setCsrf=value=>{csrf=value||'';};
export async function api(path,options={}){const isForm=options.body instanceof FormData;const response=await fetch(`/api${path}`,{credentials:'same-origin',...options,headers:{...(!isForm&&options.body?{'Content-Type':'application/json'}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...options.headers},...(options.body&&!isForm?{body:JSON.stringify(options.body)}:{})});const data=await response.json().catch(()=>({error:'Unexpected server response.'}));if(!response.ok)throw new Error(data.error||'Request failed.');return data;}
export const money=(value,currency='INR')=>new Intl.NumberFormat(currency==='INR'?'en-IN':'en-US',{style:'currency',currency}).format(value/100);
