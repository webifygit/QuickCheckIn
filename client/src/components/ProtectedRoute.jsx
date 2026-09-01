import { Navigate, useLocation } from 'react-router-dom';
import { getToken } from '../api/client';

export default function ProtectedRoute({ children }) {
  const location = useLocation();
  const token = getToken();

  if (!token) {
    // Remember where they were headed so signing in returns them there rather
    // than dumping everyone on the dashboard.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return children;
}
