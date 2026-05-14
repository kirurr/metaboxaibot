/**
 * Static catalog of ElevenLabs voices available through the Kie.ai aggregator.
 *
 * Kie does not expose a live voices API — its `elevenlabs/text-to-speech-*`
 * models accept only a fixed enum of voice IDs. This list is transcribed
 * verbatim from the Kie OpenAPI specs (text-to-speech-multilingual-v2 /
 * text-to-speech-turbo-2-5). Keep it in sync if Kie revises the enum.
 *
 * Voice previews are served at a predictable URL:
 *   https://static.aiquickdraw.com/elevenlabs/voice/<voice_id>.mp3
 */
export interface KieElevenLabsVoice {
  voice_id: string;
  /** Short display name. Not unique on its own (e.g. two "Mark") — `description` disambiguates. */
  name: string;
  /** Voice flavour from the Kie spec (timbre/style). Empty for label-only entries. */
  description: string;
}

export const KIE_ELEVENLABS_VOICES: ReadonlyArray<KieElevenLabsVoice> = [
  { voice_id: "EkK5I93UQWFDigLMpZcX", name: "James", description: "Husky, Engaging and Bold" },
  { voice_id: "Z3R5wn05IrDiVCyEkUrK", name: "Arabella", description: "Mysterious and Emotive" },
  { voice_id: "NNl6r8mD7vthiJatiJt1", name: "Bradford", description: "Expressive and Articulate" },
  {
    voice_id: "YOq2y2Up4RgXP2HyXjE5",
    name: "Xavier",
    description: "Dominating, Metallic Announcer",
  },
  { voice_id: "B8gJV1IhpuegLxdpXFOE", name: "Kuon", description: "Cheerful, Clear and Steady" },
  { voice_id: "2zRM7PkgwBPiau2jvVXc", name: "Monika Sogam", description: "Deep and Natural" },
  { voice_id: "1SM7GgM6IMuvQlz2BwM3", name: "Mark", description: "Casual, Relaxed and Light" },
  { voice_id: "5l5f8iK3YPeGga21rQIX", name: "Adeline", description: "Feminine and Conversational" },
  { voice_id: "scOwDtmlUjD3prqpp97I", name: "Sam", description: "Support Agent" },
  { voice_id: "NOpBlnGInO9m6vDvFkFC", name: "Spuds Oxley", description: "Wise and Approachable" },
  { voice_id: "BZgkqPqms7Kj9ulSkVzn", name: "Eve", description: "Authentic, Energetic and Happy" },
  { voice_id: "wo6udizrrtpIxWGp2qJk", name: "Northern Terry", description: "" },
  { voice_id: "gU0LNdkMOQCOrPrwtbee", name: "British Football Announcer", description: "" },
  {
    voice_id: "DGzg6RaUqxGRTHSBjfgF",
    name: "Brock",
    description: "Commanding and Loud Sergeant",
  },
  { voice_id: "x70vRnQBMBu4FAYhjJbO", name: "Nathan", description: "Virtual Radio Host" },
  {
    voice_id: "Sm1seazb4gs7RSlUVw7c",
    name: "Anika",
    description: "Animated, Friendly and Engaging",
  },
  { voice_id: "P1bg08DkjqiVEzOn76yG", name: "Viraj", description: "Rich and Soft" },
  { voice_id: "qDuRKMlYmrm8trt5QyBn", name: "Taksh", description: "Calm, Serious and Smooth" },
  { voice_id: "qXpMhyvQqiRxWQs4qSSB", name: "Horatius", description: "Energetic Character Voice" },
  {
    voice_id: "TX3LPaxmHKxFdv7VOQHJ",
    name: "Liam",
    description: "Energetic, Social Media Creator",
  },
  { voice_id: "N2lVS1w4EtoT3dr4eOWO", name: "Callum", description: "Husky Trickster" },
  { voice_id: "FGY2WhTYpPnrIDTdsKH5", name: "Laura", description: "Enthusiast, Quirky Attitude" },
  {
    voice_id: "kPzsL2i3teMYv0FxEYQ6",
    name: "Brittney",
    description: "Social Media Voice - Fun, Youthful & Informative",
  },
  { voice_id: "UgBBYS2sOqTuMpoF3BR0", name: "Mark", description: "Natural Conversations" },
  { voice_id: "hpp4J3VqNfWAUOO0d1Us", name: "Bella", description: "Professional, Bright, Warm" },
  {
    voice_id: "nPczCjzI2devNBz1zQrb",
    name: "Brian",
    description: "Deep, Resonant and Comforting",
  },
  { voice_id: "uYXf8XasLslADfZ2MB4u", name: "Hope", description: "Bubbly, Gossipy and Girly" },
  { voice_id: "gs0tAILXbY5DNrJrsM6F", name: "Jeff", description: "Classy, Resonating and Strong" },
  { voice_id: "DTKMou8ccj1ZaWGBiotd", name: "Jamahal", description: "Young, Vibrant, and Natural" },
  { voice_id: "vBKc2FfBKJfcZNyEt1n6", name: "Finn", description: "Youthful, Eager and Energetic" },
  { voice_id: "DYkrAHD8iwork3YSUBbs", name: "Tom", description: "Conversations & Books" },
  { voice_id: "56AoDkrOh6qfVPDXZ7Pt", name: "Cassidy", description: "Crisp, Direct and Clear" },
  {
    voice_id: "eR40ATw9ArzDf9h3v7t7",
    name: "Addison 2.0",
    description: "Australian Audiobook & Podcast",
  },
  {
    voice_id: "g6xIsTj2HwM6VR4iXFCw",
    name: "Jessica Anne Bogart",
    description: "Chatty and Friendly",
  },
  { voice_id: "lcMyyd2HUfFzxdCaC4Ta", name: "Lucy", description: "Fresh & Casual" },
  { voice_id: "6aDn1KB0hjpdcocrUkmq", name: "Tiffany", description: "Natural and Welcoming" },
  {
    voice_id: "Sq93GQT4X1lKDXsQcixO",
    name: "Felix",
    description: "Warm, Positive & Contemporary RP",
  },
  {
    voice_id: "flHkNRp1BlvT73UL6gyz",
    name: "Jessica Anne Bogart",
    description: "Eloquent Villain",
  },
  {
    voice_id: "9yzdeviXkFddZ4Oz8Mok",
    name: "Lutz",
    description: "Chuckling, Giggly and Cheerful",
  },
  { voice_id: "pPdl9cQBQq4p6mRkZy2Z", name: "Emma", description: "Adorable and Upbeat" },
  { voice_id: "zYcjlYFOd3taleS0gkk3", name: "Edward", description: "Loud, Confident and Cocky" },
  { voice_id: "nzeAacJi50IvxcyDnMXa", name: "Marshal", description: "Friendly, Funny Professor" },
  { voice_id: "ruirxsoakN0GWmGNIo04", name: "John Morgan", description: "Gritty, Rugged Cowboy" },
  { voice_id: "TC0Zp7WVFzhA8zpTlRqV", name: "Aria", description: "Sultry Villain" },
  { voice_id: "ljo9gAlSqKOvF6D8sOsX", name: "Viking Bjorn", description: "Epic Medieval Raider" },
  { voice_id: "PPzYpIqttlTYA83688JI", name: "Pirate Marshal", description: "" },
  {
    voice_id: "8JVbfL6oEdmuxKn5DK2C",
    name: "Johnny Kid",
    description: "Serious and Calm Narrator",
  },
  {
    voice_id: "iCrDUkL56s3C8sCRl7wb",
    name: "Hope",
    description: "Poetic, Romantic and Captivating",
  },
  {
    voice_id: "wJqPPQ618aTW29mptyoc",
    name: "Ana Rita",
    description: "Smooth, Expressive and Bright",
  },
  { voice_id: "EiNlNiXeDU1pqqOPrYMO", name: "John Doe", description: "Deep" },
  {
    voice_id: "4YYIPFl9wE5c4L2eu2Gb",
    name: "Burt Reynolds™",
    description: "Deep, Smooth and Clear",
  },
  { voice_id: "6F5Zhi321D3Oq7v1oNT4", name: "Hank", description: "Deep and Engaging Narrator" },
  { voice_id: "YXpFCvM1S3JbWEJhoskW", name: "Wyatt", description: "Wise Rustic Cowboy" },
  {
    voice_id: "LG95yZDEHg6fCZdQjLqj",
    name: "Phil",
    description: "Explosive, Passionate Announcer",
  },
  { voice_id: "CeNX9CMwmxDxUF5Q2Inm", name: "Johnny Dynamite", description: "Vintage Radio DJ" },
  {
    voice_id: "aD6riP1btT197c6dACmy",
    name: "Rachel M",
    description: "Pro British Radio Presenter",
  },
  { voice_id: "mtrellq69YZsNwzUSyXh", name: "Rex Thunder", description: "Deep N Tough" },
  { voice_id: "dHd5gvgSOzSfduK4CvEg", name: "Ed", description: "Late Night Announcer" },
  {
    voice_id: "eVItLK1UvXctxuaRV2Oq",
    name: "Jean",
    description: "Alluring and Playful Femme Fatale",
  },
  {
    voice_id: "esy0r39YPLQjOczyOib8",
    name: "Britney",
    description: "Calm and Calculative Villain",
  },
  { voice_id: "Tsns2HvNFKfGiNjllgqo", name: "Sven", description: "Emotional and Nice" },
  { voice_id: "1U02n4nD6AdIZ9CjF053", name: "Viraj", description: "Smooth and Gentle" },
  {
    voice_id: "AeRdCCKzvd23BpJoofzx",
    name: "Nathaniel",
    description: "Engaging, British and Calm",
  },
  { voice_id: "LruHrtVF6PSyGItzMNHS", name: "Benjamin", description: "Deep, Warm, Calming" },
  {
    voice_id: "1wGbFxmAM3Fgw63G1zZJ",
    name: "Allison",
    description: "Calm, Soothing and Meditative",
  },
  { voice_id: "hqfrgApggtO1785R4Fsn", name: "Theodore HQ", description: "Serene and Grounded" },
  { voice_id: "MJ0RnG71ty4LH3dvNfSd", name: "Leon", description: "Soothing and Grounded" },
];

/** Default voice — James. Matches the `voice` default in the Kie TTS specs. */
export const KIE_ELEVENLABS_DEFAULT_VOICE_ID = "EkK5I93UQWFDigLMpZcX";

/** O(1) membership check — used to validate a requested voice against the Kie enum. */
export const KIE_ELEVENLABS_VOICE_IDS: ReadonlySet<string> = new Set(
  KIE_ELEVENLABS_VOICES.map((v) => v.voice_id),
);

/** Builds the public preview URL for a Kie ElevenLabs voice. */
export function kieElevenLabsVoicePreviewUrl(voiceId: string): string {
  return `https://static.aiquickdraw.com/elevenlabs/voice/${voiceId}.mp3`;
}
