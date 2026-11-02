import { Routes, Route } from "react-router-dom";
import LandingPage from "./pages/LandingPage";
import PrivacyPage from "./pages/PrivacyPage";
import RoomPage from "./pages/RoomPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/room/:roomId" element={<RoomPage />} />
    </Routes>
  );
}
