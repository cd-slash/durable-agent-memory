/** Bound native/DO operations even when they do not honor cancellation themselves. */
export async function interruptible<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
  let abort:()=>void = ()=>{};
  const interrupted=new Promise<never>((_,reject)=>{abort=()=>reject(new Error('Sandbox operation interrupted'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
  try{return await Promise.race([work,interrupted]);}finally{signal.removeEventListener('abort',abort);}
}
export async function within<T>(work:Promise<T>,ms=5000):Promise<T> {
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),ms);
  try{return await interruptible(work,controller.signal);}finally{clearTimeout(timer);}
}
