/** Hawmess brand logo (files in /public). */
export const LogoNav = ({ height = 50 }: { height?: number }) => <img className="brand-img" src="/hawmess-logo-nav.png" alt="Hawmess" height={height} style={{ height }} />;
export const LogoFull = ({ width = 420 }: { width?: number }) => <img className="brand-img" src="/hawmess-logo.png" alt="Hawmess - All your tickets, in one place" style={{ width: `min(${width}px, 100%)`, height: 'auto' }} />;
