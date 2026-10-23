/** Barid-IN brand logo (files in /public). */
export const LogoNav = ({ height = 50 }: { height?: number }) => <img className="brand-img" src="/barid-logo-nav.png" alt="Barid-IN" height={height} style={{ height }} />;
export const LogoFull = ({ width = 420 }: { width?: number }) => <img className="brand-img" src="/barid-logo.png" alt="Barid-IN" style={{ width: `min(${width}px, 100%)`, height: 'auto' }} />;
