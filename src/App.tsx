import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { AppLayout } from "@/components/AppLayout";
import Index from "./pages/Index";
import ProjectEditor from "./pages/ProjectEditor";
import ProjectGallery from "./pages/ProjectGallery";
import RunMonitor from "./pages/RunMonitor";
import SettingsPage from "./pages/SettingsPage";
import LoginPage from "./pages/LoginPage";
import NotFound from "./pages/NotFound";
import StoriesIndex from "./pages/StoriesIndex";
import StoryProjectEditor from "./pages/StoryProjectEditor";
import StoryRunMonitor from "./pages/StoryRunMonitor";
import AnalyticsDashboard from "./pages/AnalyticsDashboard";

const queryClient = new QueryClient();

function ProtectedRoutes() {
  const { session, loading } = useAuth();

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading...</div>;
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<Index />} />
        <Route path="/projects/:projectId" element={<ProjectEditor />} />
        <Route path="/projects/:projectId/gallery" element={<ProjectGallery />} />
        <Route path="/runs/:runId" element={<RunMonitor />} />
        <Route path="/stories" element={<StoriesIndex />} />
        <Route path="/stories/:projectId" element={<StoryProjectEditor />} />
        <Route path="/story-runs/:runId" element={<StoryRunMonitor />} />
        <Route path="/analytics" element={<AnalyticsDashboard />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function AppRoutes() {
  const { session, loading } = useAuth();

  return (
    <Routes>
      <Route
        path="/login"
        element={
          loading ? (
            <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading...</div>
          ) : session ? (
            <Navigate to="/" replace />
          ) : (
            <LoginPage />
          )
        }
      />
      <Route path="/*" element={<ProtectedRoutes />} />
    </Routes>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
