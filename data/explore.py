import pandas as pd

print("Loading ipl.csv...")
df = pd.read_csv("ipl/ipl.csv", low_memory=False)

print(f"\n=== SHAPE ===")
print(f"Rows: {len(df):,}  |  Cols: {len(df.columns)}")

print(f"\n=== ALL COLUMNS ===")
for i, col in enumerate(df.columns):
    print(f"  [{i:2d}] {col}")

print(f"\n=== FIRST ROW (every field) ===")
for col in df.columns:
    print(f"  {col:40s} = {repr(df[col].iloc[0])}")

print(f"\n=== UNIQUE VALUE COUNTS ===")
for col in df.columns:
    u = df[col].nunique()
    sample = df[col].dropna().unique()[:4].tolist()
    print(f"  {col:40s} : {u:6,} unique  | sample: {sample}")

print(f"\n=== NULL COUNTS (only cols with nulls) ===")
nulls = df.isnull().sum()
for col, n in nulls[nulls > 0].items():
    print(f"  {col:40s} : {n:,} nulls ({n/len(df)*100:.1f}%)")
