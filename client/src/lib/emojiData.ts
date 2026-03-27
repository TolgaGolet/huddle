export interface EmojiCategory {
  name: string;
  icon: string;
  emojis: string[];
}

export const CATEGORIES: EmojiCategory[] = [
  {
    name: "Smileys",
    icon: "😀",
    emojis: [
      "😀","😃","😄","😁","😆","😅","🤣","😂","🙂","😊",
      "😇","🥰","😍","🤩","😘","😗","😚","😙","🥲","😋",
      "😛","😜","🤪","😝","🤑","🤗","🤭","🫢","🤫","🤔",
      "🫡","🤐","🤨","😐","😑","😶","🫥","😏","😒","🙄",
      "😬","🤥","😌","😔","😪","🤤","😴","😷","🤒","🤕",
      "🤢","🤮","🥵","🥶","🥴","😵","🤯","🤠","🥳","🥸",
      "😎","🤓","🧐","😕","🫤","😟","🙁","😮","😯","😲",
      "😳","🥺","🥹","😦","😧","😨","😰","😥","😢","😭",
      "😱","😖","😣","😞","😓","😩","😫","🥱","😤","😡",
      "😠","🤬","😈","👿","💀","☠️","💩","🤡","👹","👺",
    ],
  },
  {
    name: "Gestures",
    icon: "👋",
    emojis: [
      "👋","🤚","🖐️","✋","🖖","🫱","🫲","🫳","🫴","👌",
      "🤌","🤏","✌️","🤞","🫰","🤟","🤘","🤙","👈","👉",
      "👆","🖕","👇","☝️","🫵","👍","👎","✊","👊","🤛",
      "🤜","👏","🙌","🫶","👐","🤲","🤝","🙏","✍️","💪",
    ],
  },
  {
    name: "Hearts",
    icon: "❤️",
    emojis: [
      "❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔",
      "❤️‍🔥","❤️‍🩹","❣️","💕","💞","💓","💗","💖","💘","💝",
      "💟","♥️","🫶","💑","💏","💋","😍","🥰","😘",
    ],
  },
  {
    name: "Animals",
    icon: "🐶",
    emojis: [
      "🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐻‍❄️","🐨",
      "🐯","🦁","🐮","🐷","🐸","🐵","🙈","🙉","🙊","🐒",
      "🐔","🐧","🐦","🐤","🐣","🐥","🦆","🦅","🦉","🦇",
      "🐺","🐗","🐴","🦄","🐝","🪱","🐛","🦋","🐌","🐞",
    ],
  },
  {
    name: "Food",
    icon: "🍕",
    emojis: [
      "🍎","🍐","🍊","🍋","🍌","🍉","🍇","🍓","🫐","🍈",
      "🍒","🍑","🥭","🍍","🥥","🥝","🍅","🍆","🥑","🥦",
      "🌽","🌶️","🫑","🥒","🥬","🥕","🧄","🧅","🥔","🍠",
      "🍕","🍔","🍟","🌭","🍿","🧂","🥚","🍳","🧈","🥞",
    ],
  },
  {
    name: "Objects",
    icon: "💡",
    emojis: [
      "⌚","📱","💻","⌨️","🖥️","🖨️","🖱️","🖲️","💾","💿",
      "📷","📹","🎥","📞","☎️","📺","📻","🎙️","⏰","🔋",
      "🔌","💡","🔦","🕯️","🧯","💰","💳","💎","⚖️","🔧",
      "🔨","⚒️","🛠️","⛏️","🔩","⚙️","🔗","📎","✂️","📌",
    ],
  },
  {
    name: "Symbols",
    icon: "✨",
    emojis: [
      "⭐","🌟","✨","⚡","🔥","💥","❄️","🌈","☀️","🌤️",
      "⛅","🌥️","☁️","🌧️","⛈️","🌩️","❄️","💨","💧","💦",
      "☔","🎵","🎶","🔔","🎉","🎊","🏆","🥇","🥈","🥉",
      "⚽","🏀","🏈","⚾","🎾","🏐","🎯","♟️","🎲","🎮",
      "✅","❌","❓","❗","💯","🔴","🟠","🟡","🟢","🔵",
    ],
  },
];

export const EMOJI_NAMES: Record<string, string> = {
  // Smileys
  "😀": "grinning", "😃": "smiley", "😄": "smile", "😁": "grin",
  "😆": "laughing", "😅": "sweat smile", "🤣": "rolling laughing rofl",
  "😂": "joy laugh cry", "🙂": "slightly smiling", "😊": "blush smiling",
  "😇": "angel halo", "🥰": "smiling hearts", "😍": "heart eyes",
  "🤩": "star struck", "😘": "blowing kiss", "😗": "kissing",
  "😚": "kissing closed eyes", "😙": "kissing smiling",
  "🥲": "smiling tear", "😋": "yum food", "😛": "tongue out",
  "😜": "winking tongue", "🤪": "zany crazy", "😝": "squinting tongue",
  "🤑": "money mouth", "🤗": "hugging", "🤭": "hand over mouth",
  "🫢": "gasp surprised", "🤫": "shush quiet", "🤔": "thinking",
  "🫡": "salute", "🤐": "zipper mouth silent", "🤨": "raised eyebrow",
  "😐": "neutral", "😑": "expressionless", "😶": "no mouth",
  "🫥": "dotted face", "😏": "smirk", "😒": "unamused",
  "🙄": "eye roll", "😬": "grimace awkward", "🤥": "lying pinocchio",
  "😌": "relieved", "😔": "pensive sad", "😪": "sleepy",
  "🤤": "drooling", "😴": "sleeping tired", "😷": "mask sick",
  "🤒": "thermometer sick", "🤕": "bandage hurt", "🤢": "nauseated sick",
  "🤮": "vomiting sick", "🥵": "hot overheated", "🥶": "cold frozen",
  "🥴": "woozy drunk dizzy", "😵": "dizzy", "🤯": "mind blown exploding",
  "🤠": "cowboy", "🥳": "party celebrating", "🥸": "disguise",
  "😎": "cool sunglasses", "🤓": "nerd glasses", "🧐": "monocle",
  "😕": "confused", "🫤": "diagonal mouth", "😟": "worried",
  "🙁": "frowning", "😮": "open mouth surprised", "😯": "hushed",
  "😲": "astonished", "😳": "flushed", "🥺": "pleading puppy eyes",
  "🥹": "holding back tears", "😦": "frowning open mouth",
  "😧": "anguished", "😨": "fearful scared", "😰": "anxious cold sweat",
  "😥": "sad relieved", "😢": "crying tear", "😭": "sobbing crying",
  "😱": "screaming fear", "😖": "confounded", "😣": "persevering",
  "😞": "disappointed", "😓": "downcast sweat", "😩": "weary",
  "😫": "tired exhausted", "🥱": "yawning bored", "😤": "steam huffing",
  "😡": "enraged angry red", "😠": "angry", "🤬": "cursing angry symbols",
  "😈": "devil smiling horns", "👿": "devil angry horns", "💀": "skull death",
  "☠️": "skull crossbones", "💩": "poop", "🤡": "clown",
  "👹": "ogre monster", "👺": "goblin",

  // Gestures
  "👋": "wave hello bye", "🤚": "raised back hand", "🖐️": "hand fingers splayed",
  "✋": "raised hand stop", "🖖": "vulcan salute", "🫱": "right hand",
  "🫲": "left hand", "🫳": "palm down", "🫴": "palm up",
  "👌": "ok perfect", "🤌": "pinched fingers", "🤏": "pinching hand",
  "✌️": "peace victory", "🤞": "crossed fingers luck", "🫰": "snap fingers",
  "🤟": "love you gesture", "🤘": "rock horns metal", "🤙": "call me shaka",
  "👈": "point left", "👉": "point right", "👆": "point up",
  "🖕": "middle finger", "👇": "point down", "☝️": "index pointing up",
  "🫵": "pointing at you", "👍": "thumbs up like", "👎": "thumbs down dislike",
  "✊": "raised fist", "👊": "punch fist", "🤛": "left fist",
  "🤜": "right fist", "👏": "clap applause", "🙌": "raising hands",
  "🫶": "heart hands love", "👐": "open hands", "🤲": "palms up together",
  "🤝": "handshake agreement", "🙏": "pray please thanks folded hands",
  "✍️": "writing hand", "💪": "muscle strong flex",

  // Hearts
  "❤️": "red heart love", "🧡": "orange heart", "💛": "yellow heart",
  "💚": "green heart", "💙": "blue heart", "💜": "purple heart",
  "🖤": "black heart", "🤍": "white heart", "🤎": "brown heart",
  "💔": "broken heart", "❤️‍🔥": "heart on fire passion", "❤️‍🩹": "mending healing heart",
  "❣️": "heart exclamation", "💕": "two hearts", "💞": "revolving hearts",
  "💓": "beating heart", "💗": "growing heart", "💖": "sparkling heart",
  "💘": "heart with arrow", "💝": "heart ribbon", "💟": "heart decoration",
  "♥️": "heart suit", "💑": "couple heart", "💏": "kiss couple",
  "💋": "kiss lips mark",

  // Animals
  "🐶": "dog puppy", "🐱": "cat kitty", "🐭": "mouse", "🐹": "hamster",
  "🐰": "rabbit bunny", "🦊": "fox", "🐻": "bear", "🐼": "panda",
  "🐻‍❄️": "polar bear", "🐨": "koala", "🐯": "tiger", "🦁": "lion",
  "🐮": "cow", "🐷": "pig", "🐸": "frog", "🐵": "monkey face",
  "🙈": "see no evil monkey", "🙉": "hear no evil monkey", "🙊": "speak no evil monkey",
  "🐒": "monkey", "🐔": "chicken", "🐧": "penguin", "🐦": "bird",
  "🐤": "baby chick", "🐣": "hatching chick egg", "🐥": "front chick",
  "🦆": "duck", "🦅": "eagle", "🦉": "owl", "🦇": "bat",
  "🐺": "wolf", "🐗": "boar pig", "🐴": "horse", "🦄": "unicorn",
  "🐝": "bee honeybee", "🪱": "worm", "🐛": "caterpillar bug",
  "🦋": "butterfly", "🐌": "snail slow", "🐞": "ladybug ladybird",

  // Food
  "🍎": "apple red", "🍐": "pear", "🍊": "orange tangerine",
  "🍋": "lemon", "🍌": "banana", "🍉": "watermelon",
  "🍇": "grapes", "🍓": "strawberry", "🫐": "blueberry",
  "🍈": "melon", "🍒": "cherry", "🍑": "peach",
  "🥭": "mango", "🍍": "pineapple", "🥥": "coconut",
  "🥝": "kiwi fruit", "🍅": "tomato", "🍆": "eggplant aubergine",
  "🥑": "avocado", "🥦": "broccoli", "🌽": "corn maize",
  "🌶️": "chili pepper hot spicy", "🫑": "bell pepper",
  "🥒": "cucumber", "🥬": "salad greens lettuce", "🥕": "carrot",
  "🧄": "garlic", "🧅": "onion", "🥔": "potato",
  "🍠": "sweet potato", "🍕": "pizza", "🍔": "hamburger burger",
  "🍟": "french fries chips", "🌭": "hot dog sausage", "🍿": "popcorn",
  "🧂": "salt shaker", "🥚": "egg", "🍳": "cooking frying",
  "🧈": "butter", "🥞": "pancakes",

  // Objects
  "⌚": "watch clock", "📱": "phone mobile cell", "💻": "laptop computer",
  "⌨️": "keyboard", "🖥️": "desktop monitor screen", "🖨️": "printer",
  "🖱️": "mouse computer", "🖲️": "trackball", "💾": "floppy disk save",
  "💿": "cd disc", "📷": "camera photo", "📹": "video camera",
  "🎥": "movie film camera", "📞": "phone receiver call", "☎️": "telephone",
  "📺": "tv television screen", "📻": "radio", "🎙️": "microphone studio",
  "⏰": "alarm clock wake", "🔋": "battery power", "🔌": "plug power cable",
  "💡": "light bulb idea", "🔦": "flashlight torch", "🕯️": "candle flame",
  "🧯": "fire extinguisher", "💰": "money bag cash", "💳": "credit card",
  "💎": "diamond gem jewel", "⚖️": "scale balance justice", "🔧": "wrench tool",
  "🔨": "hammer", "⚒️": "hammer pick", "🛠️": "tools repair",
  "⛏️": "pick axe mine", "🔩": "nut bolt", "⚙️": "gear settings cog",
  "🔗": "link chain", "📎": "paperclip", "✂️": "scissors cut",
  "📌": "pin pushpin",

  // Symbols
  "⭐": "star", "🌟": "glowing star", "✨": "sparkles magic twinkle",
  "⚡": "lightning bolt zap thunder", "🔥": "fire hot flame",
  "💥": "explosion boom bang", "❄️": "snowflake cold winter",
  "🌈": "rainbow", "☀️": "sun sunny", "🌤️": "partly cloudy sun",
  "⛅": "cloud sun partly", "🌥️": "cloudy", "☁️": "cloud overcast",
  "🌧️": "rain rainy", "⛈️": "thunderstorm", "🌩️": "lightning storm",
  "💨": "wind breeze", "💧": "droplet water", "💦": "splash water",
  "☔": "umbrella rain", "🎵": "music note song", "🎶": "musical notes melody",
  "🔔": "bell notification alert", "🎉": "party popper celebrate",
  "🎊": "confetti celebrate", "🏆": "trophy winner", "🥇": "gold medal first",
  "🥈": "silver medal second", "🥉": "bronze medal third",
  "⚽": "soccer football ball", "🏀": "basketball", "🏈": "american football",
  "⚾": "baseball", "🎾": "tennis", "🏐": "volleyball",
  "🎯": "target bullseye dart", "♟️": "chess pawn", "🎲": "dice game",
  "🎮": "game controller video", "✅": "check done tick", "❌": "cross wrong x",
  "❓": "question mark", "❗": "exclamation mark", "💯": "hundred perfect",
  "🔴": "red circle dot", "🟠": "orange circle", "🟡": "yellow circle",
  "🟢": "green circle", "🔵": "blue circle",
};

const RECENT_KEY = "huddle_recent_emojis";
const MAX_RECENT = 5;

export function loadRecentEmojis(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_KEY);
    return stored ? (JSON.parse(stored) as string[]) : [];
  } catch {
    return [];
  }
}

export function saveRecentEmoji(emoji: string): string[] {
  const current = loadRecentEmojis().filter((e) => e !== emoji);
  const updated = [emoji, ...current].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
  } catch {
    // ignore storage errors
  }
  return updated;
}
