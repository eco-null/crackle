// Site settings. A Spotify client ID is public (PKCE needs no secret), so it can live here:
// fill it in once and every screen that opens this site gets a one-click "Log in with Spotify".
// Leave empty to ask for it in the Sources sheet instead.
export const SPOTIFY_CLIENT_ID = '5badfa202a844ee394d71752aa967da8';

// Optional YouTube Data API v3 key (restrict it to this site's address in Google Cloud). With a key,
// YouTube search goes to Google directly; without one it uses public Piped mirrors, which can be down.
export const YOUTUBE_API_KEY = '';
