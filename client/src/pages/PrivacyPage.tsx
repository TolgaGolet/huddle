import { Link } from "react-router-dom";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-gray-950 px-4 py-12">
      <main className="w-full max-w-xl mx-auto text-sm leading-relaxed text-gray-300">
        <h1 className="text-3xl font-bold text-white tracking-tight mb-6">Privacy</h1>
        <p className="mb-4">
          Huddle has no accounts. The server keeps your display name, messages, polls and images in order to run the room, and it
          uses your IP address for abuse limits. All of this is deleted when the room ends, and none of it is written to logs.
        </p>
        <h2 className="text-base font-semibold text-white mt-6 mb-2">What other people in the room can see</h2>
        <ul className="list-disc pl-5 space-y-2 mb-4">
          <li>
            <strong className="text-gray-100">Your IP address.</strong> Voice and screen sharing connect browsers directly to each
            other, so everyone in a room can find each other's IP address, which can reveal your rough location.
          </li>
        </ul>
        <p className="mb-4">The server removes hidden details from photos, such as where they were taken, before sharing them.</p>
        <h2 className="text-base font-semibold text-white mt-6 mb-2">Encryption</h2>
        <p className="mb-4">
          Voice and screen sharing are encrypted between browsers. Messages and images are not end-to-end encrypted, so whoever
          runs the server could read them, even in a room with a password.
        </p>
        <h2 className="text-base font-semibold text-white mt-6 mb-2">Other services</h2>
        <p className="mb-4">
          GIFs come from Giphy, which sees your IP address when your browser loads one, and search terms are sent to it. Google's
          STUN servers help browsers connect. The hosting provider handles all traffic to this site.
        </p>
        <Link to="/" className="text-indigo-400 hover:underline">Back to Huddle</Link>
      </main>
    </div>
  );
}
