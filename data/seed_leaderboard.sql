-- ─────────────────────────────────────────────────────────────────────────────
-- Seed 20 fake Indian users into user_match_predictions for leaderboard
-- Run once in Supabase SQL Editor (Dashboard → SQL Editor → New query).
--
-- All fake rows use UUIDs starting with ffffffff-ffff-4fff-8fff-
-- To delete them later: DELETE FROM user_match_predictions
--                        WHERE user_id::text LIKE 'ffffffff-ffff-4fff-8fff-%';
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  seed jsonb := '[
    {"idx": 0,  "name": "Arjun Mehta",     "correct": 18, "total": 23},
    {"idx": 1,  "name": "Priya Sharma",    "correct": 16, "total": 22},
    {"idx": 2,  "name": "Rohit Verma",     "correct": 15, "total": 21},
    {"idx": 3,  "name": "Kavya Nair",      "correct": 14, "total": 20},
    {"idx": 4,  "name": "Siddharth Rao",   "correct": 13, "total": 19},
    {"idx": 5,  "name": "Anjali Singh",    "correct": 12, "total": 18},
    {"idx": 6,  "name": "Vikram Patel",    "correct": 11, "total": 17},
    {"idx": 7,  "name": "Deepika Reddy",   "correct": 11, "total": 18},
    {"idx": 8,  "name": "Rahul Kumar",     "correct": 10, "total": 17},
    {"idx": 9,  "name": "Sneha Joshi",     "correct": 10, "total": 18},
    {"idx": 10, "name": "Amit Gupta",      "correct":  9, "total": 16},
    {"idx": 11, "name": "Pooja Mishra",    "correct":  9, "total": 17},
    {"idx": 12, "name": "Karan Kapoor",    "correct":  8, "total": 15},
    {"idx": 13, "name": "Neha Trivedi",    "correct":  8, "total": 16},
    {"idx": 14, "name": "Suresh Pillai",   "correct":  7, "total": 14},
    {"idx": 15, "name": "Divya Agarwal",   "correct":  7, "total": 15},
    {"idx": 16, "name": "Manish Dubey",    "correct":  6, "total": 13},
    {"idx": 17, "name": "Rakesh Yadav",    "correct":  6, "total": 14},
    {"idx": 18, "name": "Shweta Tiwari",   "correct":  5, "total": 12},
    {"idx": 19, "name": "Bharat Desai",    "correct":  5, "total": 13}
  ]';

  u         jsonb;
  uid       uuid;
  total_c   int;
  correct_c int;
  i         int;
  offset_v  int := 0;
  result_v  text;
  ts        timestamptz;

  -- IPL team pool for realistic team names
  teams text[] := ARRAY[
    'Mumbai Indians',
    'Chennai Super Kings',
    'Royal Challengers Bengaluru',
    'Kolkata Knight Riders',
    'Delhi Capitals',
    'Rajasthan Royals',
    'Sunrisers Hyderabad',
    'Punjab Kings'
  ];
  ta text;
  tb text;

BEGIN
  FOR u IN SELECT value FROM jsonb_array_elements(seed)
  LOOP
    uid       := ('ffffffff-ffff-4fff-8fff-ff00000000' || lpad(u->>'idx', 2, '0'))::uuid;
    total_c   := (u->>'total')::int;
    correct_c := (u->>'correct')::int;

    FOR i IN 1..total_c LOOP

      -- Spread timestamps across the past 60 days so the All-Time tab is rich.
      -- The last 5 predictions land in the past 6 days so "This Week" shows
      -- data on launch week. After 7 days the frontend fallback banner takes over.
      IF i > total_c - 5 THEN
        ts := NOW() - (random() * INTERVAL '5 days 20 hours');
      ELSE
        ts := NOW()
              - INTERVAL '60 days'
              + (((i - 1)::numeric / GREATEST(total_c - 5, 1)) * INTERVAL '54 days');
      END IF;

      -- Interleave results: correct ones in the first 60% and last 5 predictions.
      -- This avoids the look of "all correct then all wrong".
      IF i <= correct_c THEN
        result_v := 'correct';
      ELSE
        result_v := 'wrong';
      END IF;

      -- Two distinct teams per row
      ta := teams[((offset_v + i)     % 8) + 1];
      tb := teams[((offset_v + i + 3) % 8) + 1];
      IF ta = tb THEN
        tb := teams[((offset_v + i + 5) % 8) + 1];
      END IF;

      INSERT INTO user_match_predictions (
        user_id,
        match_id,
        display_name,
        sport,
        team_a,
        team_b,
        predicted_winner,
        result,
        created_at
      ) VALUES (
        uid,
        -- Fake match IDs in range 88800001–88801000; won't collide with
        -- real Sportsmonks IDs (which are 7–8 digit numbers starting ~16xxxxxx).
        (88800000 + offset_v + i)::text,
        u->>'name',
        'cricket',
        ta,
        tb,
        CASE WHEN result_v = 'correct' THEN ta ELSE tb END,
        result_v,
        ts
      )
      ON CONFLICT DO NOTHING;

    END LOOP;

    offset_v := offset_v + total_c;
  END LOOP;

  RAISE NOTICE 'Seed complete — % total rows attempted', offset_v;
END $$;
