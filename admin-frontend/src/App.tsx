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
import { MobileMoneyAlertsPage } from "./pages/MobileMoneyAlertsPage";
import { PlansPage } from "./pages/PlansPage";

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
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
          <Route path="/" element={<Navigate to="/businesses" replace />} />
          <Route path="*" element={<Navigate to="/businesses" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
