import { expect, it } from 'vitest';
import { resolveCampaignUrl } from '../ui/campaign-url';
const base='https://app.example/products/current';
it.each(['javascript:alert(1)',' \tJaVaScRiPt:alert(1)','java\nscript:alert(1)','data:text/html,<script>alert(1)</script>','vbscript:alert(1)','file:///etc/passwd','blob:https://app.example/id','about:blank','custom:action','http://[', '', null, 1])('rejects unsafe or malformed campaign destination %s',value=>{
 expect(resolveCampaignUrl(value,base)).toBeNull();
});
it.each([
 ['https://docs.example/a?b=1#c','https://docs.example/a?b=1#c'],
 ['http://localhost:3000/help','http://localhost:3000/help'],
 ['/account','https://app.example/account'],['next','https://app.example/products/next'],
 ['?step=2','https://app.example/products/current?step=2'],['#details','https://app.example/products/current#details'],
 ['//docs.example/help','https://docs.example/help'],['mailto:help@example.com','mailto:help@example.com'],['tel:+15551234567','tel:+15551234567'],
])('preserves intended navigation %s', (value,expected)=>{expect(resolveCampaignUrl(value,base)).toBe(expected);});
