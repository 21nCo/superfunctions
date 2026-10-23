import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './auth';
import { RunList } from './pages/RunList';
import { RunDetail } from './pages/RunDetail';
import { LogsView } from './pages/LogsView';
import { ArtifactsList } from './pages/ArtifactsList';
import { Login } from './pages/Login';
import { Layout } from './Layout';
import './index.css';

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<RunList />} />
            <Route path="/login" element={<Login />} />
            <Route path="/runs/:runId" element={<RunDetail />} />
            <Route path="/runs/:runId/jobs/:jobKey/logs" element={<LogsView />} />
            <Route path="/runs/:runId/artifacts" element={<ArtifactsList />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </AuthProvider>
  );
}
