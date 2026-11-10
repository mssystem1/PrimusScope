import {handleDeveloperRequest} from '../../../../../lib/developer-api';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=15;
type Context={params:Promise<{segments:string[]}>};
async function handle(request:Request,context:Context){return handleDeveloperRequest(request,(await context.params).segments);}
export {handle as GET,handle as POST,handle as DELETE,handle as OPTIONS};
