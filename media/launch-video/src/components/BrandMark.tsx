import { interpolate, useCurrentFrame } from "remotion";

export const BrandMark = ({ size = 210 }: { size?: number }) => {
  const frame = useCurrentFrame();
  const rotation = interpolate(frame, [0, 120], [-12, 12], {
    extrapolateRight: "clamp",
  });

  return (
    <svg aria-label="Neutral gear routing mark" width={size} height={size} viewBox="0 0 200 200" style={{ rotate: `${rotation}deg` }}>
      <defs>
        <linearGradient id="gear-gold" x1="0" x2="1">
          <stop stopColor="#FFCC66" />
          <stop offset="1" stopColor="#A66A16" />
        </linearGradient>
      </defs>
      <g fill="none" stroke="url(#gear-gold)" strokeWidth="12" strokeLinecap="round">
        <circle cx="100" cy="100" r="56" />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
          <line key={angle} x1="100" y1="24" x2="100" y2="44" transform={`rotate(${angle} 100 100)`} />
        ))}
        <path d="M75 100h50M100 75v50" strokeWidth="7" />
      </g>
      <circle cx="100" cy="100" r="12" fill="#121720" stroke="#E8EDF4" strokeWidth="4" />
      <circle cx="36" cy="100" r="9" fill="#72DEFF" />
      <circle cx="164" cy="72" r="9" fill="#C39BFF" />
      <path d="M45 100h28M145 77l-20 15" stroke="#8F9FB3" strokeWidth="4" />
    </svg>
  );
};
