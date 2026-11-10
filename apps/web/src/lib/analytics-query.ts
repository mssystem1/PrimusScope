import { z } from 'zod';
export const rangeQuery=z.enum(['24h','7d','30d','all']);
export const intervalQuery=z.enum(['hour','day']);
export const analyticsQuery=z.object({range:rangeQuery.optional(),interval:intervalQuery.optional(),routeId:z.string().min(1).max(100).optional()}).strict();
export function parseAnalyticsPage(input:Record<string,string|string[]|undefined>,defaults:{range:'24h'|'30d';interval:'hour'|'day'}){
  const result=analyticsQuery.safeParse(input);
  return result.success?{range:result.data.range??defaults.range,interval:result.data.interval??defaults.interval}:defaults;
}
