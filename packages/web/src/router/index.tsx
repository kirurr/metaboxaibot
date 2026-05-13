import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { ProtectedRoute, GuestOnlyRoute, AdminRoute } from "./guards";

// Lazy-loaded pages — каждый роут отдельным чанком
const LoginPage = lazy(() => import("@/pages/Login"));
const SignupPage = lazy(() => import("@/pages/Signup"));
const ForgotPasswordPage = lazy(() => import("@/pages/ForgotPassword"));
const ResetPasswordPage = lazy(() => import("@/pages/ResetPassword"));

const HomePage = lazy(() => import("@/pages/Home"));
const ChatPage = lazy(() => import("@/pages/Chat"));
const ImagePage = lazy(() => import("@/pages/Image"));
const VideoPage = lazy(() => import("@/pages/Video"));
const AudioPage = lazy(() => import("@/pages/Audio"));
const HistoryPage = lazy(() => import("@/pages/History"));
const PlansPage = lazy(() => import("@/pages/Plans"));
const TokensPage = lazy(() => import("@/pages/Tokens"));
const ProfilePage = lazy(() => import("@/pages/Profile"));
const BillingPage = lazy(() => import("@/pages/Billing"));

const PaymentSuccessPage = lazy(() => import("@/pages/PaymentSuccess"));
const PaymentPendingPage = lazy(() => import("@/pages/PaymentPending"));
const PaymentFailedPage = lazy(() => import("@/pages/PaymentFailed"));

const NotFoundPage = lazy(() => import("@/pages/NotFound"));

const AdminLayout = lazy(() => import("@/pages/AdminLayout"));
const AdminKeysPage = lazy(() => import("@/pages/AdminKeys"));
const AdminProxiesPage = lazy(() => import("@/pages/AdminProxies"));
const AdminPricingPage = lazy(() => import("@/pages/AdminPricing"));
const WebSocketPage = lazy(() => import("@/pages/WebSocket"));
const PromptsPage = lazy(() => import("@/pages/PromptsPage"));

function PageFallback() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-text-secondary">Загрузка…</div>
    </div>
  );
}

function withSuspense(node: React.ReactNode) {
  return <Suspense fallback={<PageFallback />}>{node}</Suspense>;
}

export const router = createBrowserRouter([
  // WebSocket
  {
    path: "/ws",
    element: <WebSocketPage />,
  },

  // Гостевые роуты
  {
    path: "/login",
    element: <GuestOnlyRoute>{withSuspense(<LoginPage />)}</GuestOnlyRoute>,
  },
  {
    path: "/signup",
    element: <GuestOnlyRoute>{withSuspense(<SignupPage />)}</GuestOnlyRoute>,
  },
  {
    path: "/forgot-password",
    element: <GuestOnlyRoute>{withSuspense(<ForgotPasswordPage />)}</GuestOnlyRoute>,
  },
  {
    path: "/reset-password",
    element: withSuspense(<ResetPasswordPage />),
  },

  // Защищённая зона — без префикса `/app`, страницы прямо на root.
  {
    path: "/",
    element: (
      <ProtectedRoute>
        <AppShell />
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: withSuspense(<HomePage />) },
      { path: "chat", element: withSuspense(<ChatPage />) },
      { path: "chat/:id", element: withSuspense(<ChatPage />) },
      { path: "image", element: withSuspense(<ImagePage />) },
      { path: "video", element: withSuspense(<VideoPage />) },
      { path: "audio", element: withSuspense(<AudioPage />) },
      { path: "history", element: withSuspense(<HistoryPage />) },
      { path: "plans", element: withSuspense(<PlansPage />) },
      { path: "tokens", element: withSuspense(<TokensPage />) },
      { path: "profile", element: withSuspense(<ProfilePage />) },
      { path: "billing", element: withSuspense(<BillingPage />) },
      { path: "prompts", element: withSuspense(<PromptsPage />) },
    ],
  },

  // Админ
  {
    path: "/admin",
    element: <AdminRoute>{withSuspense(<AdminLayout />)}</AdminRoute>,
    children: [
      { index: true, element: <Navigate to="keys" replace /> },
      { path: "keys", element: withSuspense(<AdminKeysPage />) },
      { path: "proxies", element: withSuspense(<AdminProxiesPage />) },
      { path: "pricing", element: withSuspense(<AdminPricingPage />) },
    ],
  },

  // Оплата
  {
    path: "/payment/success",
    element: <ProtectedRoute>{withSuspense(<PaymentSuccessPage />)}</ProtectedRoute>,
  },
  {
    path: "/payment/pending",
    element: <ProtectedRoute>{withSuspense(<PaymentPendingPage />)}</ProtectedRoute>,
  },
  {
    path: "/payment/failed",
    element: <ProtectedRoute>{withSuspense(<PaymentFailedPage />)}</ProtectedRoute>,
  },

  { path: "*", element: withSuspense(<NotFoundPage />) },
]);
