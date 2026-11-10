import Link from 'next/link';
import {DeveloperStudio} from '../../../components/developer-studio';
export const metadata={title:'Developer Studio'};
export default function AppsPage(){return <div className="page-content"><Link className="back-link" href="/developers">← Developer tools</Link><div className="page-intro"><div><span className="eyebrow">OFFICIAL PRIMUS SDK · OPT-IN DIAGNOSTICS</span><h1>Developer Studio</h1><p>Inspect your application’s sanitized verification diagnostics with explicit consent and seven-day retention.</p></div></div><DeveloperStudio/></div>;}
