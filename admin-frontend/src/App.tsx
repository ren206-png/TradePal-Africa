import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { Layout } from "./components/Layout";
import { AuditLogsPage } from "./pages/AuditLogsPage";
import { BusinessDetailPage } from "./pages/BusinessDetailPage";
import { BusinessesPage } from "./pages/BusinessesPage";
import { DeletionRequestsPage } from "./pages/DeletionRequestsPage";
import { FeatureFlagsPage } from "./pages/FeatureFlagsPage";
import { LoginPage } from "./pages/LoginPage";
import { ReorderPage } from "./pages/ReorderPage";
import { SupportCasesPage } from "./pages/SupportCasesPage";
import { PaymentsPage } from "./pages/PaymentsPage";
import { ModerationPage } from "./pages/ModerationPage";
import { MessagingPage } from "./pages/MessagingPage";
import { SubscriptionsPage } from "./pages/SubscriptionsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SystemHealthPage } from "./pages/SystemHealthPage";
import { TransactionsPage } from "./pages/TransactionsPage";
import { GuardPrompts } from "./components/GuardPrompts";
import { MobileMoneyAlertsPage } from "./pages/MobileMoneyAlertsPage";
import { MfaPage } from "./pages/MfaPage";
import { AcceptInvitePage } from "./pages/AcceptInvitePage";
import { StaffAccessPage } from "./pages/StaffAccessPage";
import { RefundRequestsPage } from "./pages/RefundRequestsPage";
import { PlansPage } from "./pages/PlansPage";

function App() {
  return (
    <AuthProvider>
      <GuardPrompts />
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/mfa" element={<MfaPage />} />
          <Route path="/accept-invite" element={<AcceptInvitePage />} />
          <Route
            path="/businesses"
            element={
              <ProtectedRoute>
                <Layout>
                  <BusinessesPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/businesses/:id/transactions"
            element={
              <ProtectedRoute>
                <Layout>
                  <TransactionsPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/businesses/:id"
            element={
              <ProtectedRoute>
                <Layout>
                  <BusinessDetailPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/deletion-requests"
            element={
              <ProtectedRoute>
                <Layout>
                  <DeletionRequestsPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/audit-logs"
            element={
              <ProtectedRoute>
                <Layout>
                  <AuditLogsPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/mobile-money-alerts"
            element={
              <ProtectedRoute>
                <Layout>
                  <MobileMoneyAlertsPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/plans"
            element={
              <ProtectedRoute>
                <Layout>
                  <PlansPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/feature-flags"
            element={
              <ProtectedRoute>
                <Layout>
                  <FeatureFlagsPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/refund-requests"
            element={
              <ProtectedRoute>
                <Layout>
                  <RefundRequestsPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/staff"
            element={
              <ProtectedRoute>
                <Layout>
                  <StaffAccessPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/overview"
            element={
              <ProtectedRoute>
                <Layout>
                  <OverviewPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/system-health"
            element={
              <ProtectedRoute>
                <Layout>
                  <SystemHealthPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/reorder"
            element={
              <ProtectedRoute>
                <Layout>
                  <ReorderPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/support-cases"
            element={
              <ProtectedRoute>
                <Layout>
                  <SupportCasesPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/payments"
            element={
              <ProtectedRoute>
                <Layout>
                  <PaymentsPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/moderation"
            element={
              <ProtectedRoute>
                <Layout>
                  <ModerationPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/subscriptions"
            element={
              <ProtectedRoute>
                <Layout>
                  <SubscriptionsPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/messaging"
            element={
              <ProtectedRoute>
                <Layout>
                  <MessagingPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route path="/" element={<Navigate to="/businesses" replace />} />
          <Route path="*" element={<Navigate to="/businesses" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
