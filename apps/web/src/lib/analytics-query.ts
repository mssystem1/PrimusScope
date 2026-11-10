import { z } from 'zod';
import { AnalyticsSelectionFieldsSchema, AnalyticsSelectionSchema, refineAnalyticsSelection, type AnalyticsSelection } from '@primusscope/api-schema';
export const analyticsQuery=AnalyticsSelectionFieldsSchema.extend({routeId:z.string().min(1).max(100).optional()}).strict().superRefine(refineAnalyticsSelection);
export const networkAnalyticsQuery=AnalyticsSelectionSchema;
export function parseAnalyticsPage(input:Record<string,string|string[]|undefined>,defaults:AnalyticsSelection){
  const entries=Object.fromEntries(Object.entries(input).filter(([,value])=>value!==undefined&&value!==''));
  const result=AnalyticsSelectionSchema.safeParse(entries);
  return result.success?{options:{...defaults,...result.data},error:undefined}
    :{options:defaults,error:'Choose a supported period, or two real UTC dates in order (at most 366 days). Dates require the Custom period. Each field may appear only once.'};
}
export function analyticsQueryString(options:AnalyticsSelection){
  const params=new URLSearchParams();
  for(const key of ['range','interval','from','to'] as const)if(options[key])params.set(key,options[key]!);
  return params.toString();
}
export function analyticsViewTitle(options:AnalyticsSelection){
  return (options.range==='custom'?`${options.from}–${options.to} UTC`:options.range==='all'?'All available':options.range==='24h'?'24 hours':options.range==='7d'?'7 days':'30 days')+' · '+(options.interval==='hour'?'Hourly':'Daily');
}
