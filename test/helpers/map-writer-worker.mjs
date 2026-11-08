import { createWorkAnalysis } from '../../src/work-analysis.mjs';

const root = process.argv[2];
const service = createWorkAnalysis({runner:async({previous})=>{
  process.send({state:'entered'});
  await new Promise(resolve=>process.once('message',resolve));
  return {version:1,works:previous.works};
}});
try {
  process.send({state:'ready'});
  await new Promise(resolve=>process.once('message',resolve));
  await service.start(root);
  process.send({state:'done',result:await service.wait(root)});
} catch(error) {process.send({state:'error',error:error.stack});process.exitCode=1;}
finally {await service.close();process.disconnect();}
