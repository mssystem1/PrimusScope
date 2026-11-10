import Link from 'next/link';
import {SDKInspector} from '../../../components/sdk-inspector';
export const metadata={title:'Local attestation inspector'};
export default function VerifyPage(){return <div className="page-content"><Link className="back-link" href="/developers">← Developer tools</Link><div className="page-intro"><div><span className="eyebrow">OFFICIAL PRIMUS SDK · LOCAL INSPECTION</span><h1>Local attestation inspector</h1><p>Inspect the supported SDK signature check, then compare recipient, request context and age separately.</p></div></div><SDKInspector/></div>;}
