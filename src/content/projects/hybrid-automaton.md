---
title: '6-DOF Arm: IK & Motion Planning'
summary: 'Analytic and numerical inverse kinematics for a 6-DOF manipulator, integrated with MoveIt 2 for pick-and-place.'
date: 2026-06-01
tags: ['manipulation', 'moveit2', 'kinematics', 'python']
repo: 'https://github.com/'
scene: 'robot-arm'
featured: true
---

> Placeholder project. Replace this with your own write-up.

## Overview

The arm above is a simplified version of the solver: base yaw plus a planar two-link solve for shoulder and elbow.

## Approach

1. Derive the URDF and DH parameters
2. Closed-form solution for the first three joints, spherical wrist for the last three
3. Fall back to damped least-squares when near singularities
4. Wrap it as a MoveIt 2 kinematics plugin

## Results

Add plots, videos, and timing benchmarks here.