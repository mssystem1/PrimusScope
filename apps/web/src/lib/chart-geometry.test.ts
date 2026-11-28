import {describe,expect,it} from 'vitest';
import {chartLineSegments,yieldChartAxis} from './chart-geometry';

describe('yield chart geometry',()=>{
  it('preserves isolated measurements and breaks at nulls and observation gaps',()=>{
    const rows=[0,1,2,3,6,7].map((day,i)=>({label:new Date(Date.UTC(2026,10,day+1)).toISOString(),apy:[10,null,11,12,13,null][i]}));
    expect(chartLineSegments(rows,'apy',36)).toEqual([[{index:0,value:10}],[{index:2,value:11},{index:3,value:12}],[{index:4,value:13}]]);
  });
  it('pads peaks and troughs with readable, evenly spaced percentage ticks',()=>{
    const axis=yieldChartAxis([9.39,12.39]);
    expect(axis.low).toBeLessThan(9.39);expect(axis.high).toBeGreaterThan(12.39);
    expect(axis.ticks).toEqual([13,12,11,10,9]);expect(axis.precision).toBe(0);
    const flat=yieldChartAxis([0,0]);expect(flat.high).toBeGreaterThan(0);expect(flat.low).toBeLessThan(0);
  });
});
