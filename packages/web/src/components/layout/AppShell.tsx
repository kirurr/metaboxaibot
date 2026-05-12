import { Outlet } from "react-router-dom";
import clsx from "clsx";
import { TopNav } from "./TopNav";
import { MobileTop } from "./MobileTop";
import { BottomNav } from "./BottomNav";
import { ToastContainer } from "@/components/common/ToastContainer";
import { TelegramLinkModal } from "@/components/TelegramLinkModal";
import { useUIStore } from "@/stores/uiStore";
import { useIsMobile } from "@/hooks/useIsMobile";

/**
 * Каркас защищённой зоны. Desktop: top nav + main под ним.
 * Mobile: mobile top + main + bottom nav.
 */
export function AppShell() {
  const isMobile = useIsMobile();
  const telegramLinkModal = useUIStore((s) => s.telegramLinkModal);
  const closeTelegramLinkModal = useUIStore((s) => s.closeTelegramLinkModal);

  return (
    <div className={clsx("app", isMobile && "mobile")}>
      {isMobile ? <MobileTop /> : <TopNav />}

      <main className="main">
        <Outlet />
      </main>

      {isMobile && <BottomNav />}

      <ToastContainer />

      <TelegramLinkModal
        open={telegramLinkModal.open}
        onClose={closeTelegramLinkModal}
        context={telegramLinkModal.context}
      />
    </div>
  );
}
