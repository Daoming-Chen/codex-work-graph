import { installWorkGraph } from './work-live.js';

const token=new URLSearchParams(location.hash.slice(1)).get('token');
const call=async(route,args={})=>{
  const query=new URLSearchParams(args);
  const response=await fetch(`/api/${route}?${query}`,{headers:{Authorization:`Bearer ${token}`}});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||'工作地图读取失败。');
  return result;
};
const work=installWorkGraph({call});
void work.update();
