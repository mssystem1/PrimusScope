import Link from 'next/link';
import {notFound} from 'next/navigation';
import {DeveloperStudio} from '../../../../components/developer-studio';
export const metadata={title:'Application diagnostics'};
export default async function AppPage({params}:{params:Promise<{appId:string}>}){const{appId}=await params;if(!/^[0-9a-f-]{36}$/i.test(appId))notFound();return <div className="page-content"><Link className="back-link" href="/developers/apps">← Developer Studio</Link><div className="page-intro"><div><span className="eyebrow">APPLICATION-SCOPED DIAGNOSTICS</span><h1>Application diagnostics</h1><p>Only this browser’s owner session can read or manage this project.</p></div></div><DeveloperStudio initialAppId={appId}/></div>;}
