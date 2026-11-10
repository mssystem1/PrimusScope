import {describe,expect,it} from 'vitest';
import {analyticsQuery,networkAnalyticsQuery,parseAnalyticsPage,analyticsQueryString} from './analytics-query';
import {parseNetworkPageQuery,networkViewQuery} from './network-query';
describe('analytics page and API query boundaries',()=>{
  it('rejects invalid dates and repeated fields instead of silently substituting a default dashboard',()=>{
    expect(parseAnalyticsPage({range:['7d','30d']},{range:'30d'}).error).toBeTruthy();
    expect(parseAnalyticsPage({range:'custom',from:'2026-02-30',to:'2026-03-03'},{range:'30d'}).error).toBeTruthy();
    expect(networkAnalyticsQuery.safeParse({range:'7d',routeId:'x'}).success).toBe(false);
    expect(analyticsQuery.safeParse({range:'custom',from:'2026-10-01',to:'2026-10-31',routeId:'route'}).success).toBe(true);
  });
  it('round-trips dates while separating dashboard selections from event/CSV API filters',()=>{
    const parsed=parseNetworkPageQuery({range:'custom',from:'2026-11-09',to:'2026-11-10',interval:'hour',eventKind:'SubmitTask',fromBlock:'55081642',limit:'25'});
    expect(parsed.from).toBe('2026-11-09');
    expect(networkViewQuery(parsed).toString()).toBe('fromBlock=55081642&eventKind=SubmitTask&limit=25');
    expect(analyticsQueryString(parsed)).toBe('range=custom&interval=hour&from=2026-11-09&to=2026-11-10');
  });
});
