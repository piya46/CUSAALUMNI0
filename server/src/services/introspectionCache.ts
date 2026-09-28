import type { Introspection } from '../models/ssoModel.js';

/** Bounded LRU and in-flight coalescing; credentials are already keyed hashes here. */
export class IntrospectionCache {
  private entries=new Map<string,{value:Introspection;until:number}>();
  private pending=new Map<string,Promise<Introspection>>();
  constructor(private ttlMs=5000,private capacity=10000,private now=()=>Date.now()) {
    if(ttlMs<0||ttlMs>5000||capacity<1)throw new Error('Invalid introspection cache limits');
  }
  async get(apiKeyHash:string,tokenHash:string,load:()=>Promise<Introspection>):Promise<Introspection> {
    if(this.ttlMs===0)return load();
    const key=`${apiKeyHash}:${tokenHash}`;
    const entry=this.entries.get(key);
    if(entry){
      this.entries.delete(key);
      if(entry.until>this.now()){this.entries.set(key,entry);return {...entry.value};}
    }
    const active=this.pending.get(key);if(active)return active;
    // Under saturation, retain a fixed bound on stored entries and promises.
    if(this.pending.size>=this.capacity)return load();
    const promise=load().then(value=>{
      if(value.active){
        const until=Math.min(this.now()+this.ttlMs,value.exp*1000);
        if(until>this.now()){
          if(this.entries.size>=this.capacity)this.entries.delete(this.entries.keys().next().value!);
          this.entries.set(key,{value:{...value},until});
        }
      }
      return value;
    }).finally(()=>{this.pending.delete(key);});
    this.pending.set(key,promise);return promise;
  }
}
